'use strict';

var _ = require('lodash'),
    async = require('async'),
    beanstalkConnect = require('../beanstalk_connect'),
    config = require('api-umbrella-config').global(),
    elasticSearchConnect = require('../elasticsearch_connect'),
    events = require('events'),
    logCleaner = require('./cleaner'),
    logger = require('../logger'),
    moment = require('moment'),
    mongoConnect = require('../mongo_connect'),
    redis = require('redis'),
    util = require('util');

// Ensure that url.parse(str, true) gets handled safely anywhere subsequently
// in this app.
require('api-umbrella-gatekeeper/lib/safe_url_parse');

var Worker = function() {
  this.initialize.apply(this, arguments);
};

module.exports.Worker = Worker;

util.inherits(Worker, events.EventEmitter);
_.extend(Worker.prototype, {
  initialize: function() {
    this.apiKeyMethods = config.get('gatekeeper.api_key_methods');
    async.series([
      mongoConnect,
      this.connectRedis.bind(this),
      this.connectElasticsearch.bind(this),
      this.connectBeanstalk.bind(this),
      this.connectBeanstalkDestroyer.bind(this),
    ], this.handleConnections.bind(this));
  },

  connectRedis: function(asyncReadyCallback) {
    var connected = false;
    this.redis = redis.createClient(config.get('redis.port'), config.get('redis.host'));

    this.redis.on('error', function(error) {
      logger.error({ err: error }, 'redis error');
      if(!connected) {
        asyncReadyCallback(error);
      }
    });

    this.redis.on('ready', function() {
      connected = true;
      asyncReadyCallback(null);
    });
  },

  connectElasticsearch: function(asyncReadyCallback) {
    elasticSearchConnect(function(error, client) {
      this.elasticSearch = client;
      asyncReadyCallback(error);
    }.bind(this));
  },

  connectBeanstalk: function(asyncReadyCallback) {
    beanstalkConnect(function(error, client) {
      if(!error) {
        this.beanstalk = client;
        this.beanstalk.on('reconnect', function() {
          this.reserveJob();
        }.bind(this));
      }

      asyncReadyCallback(error);
    }.bind(this));
  },

  connectBeanstalkDestroyer: function(asyncReadyCallback) {
    // Establish a separate connection for running our destroy commands, since
    // they run separately from the normal reserve flow (they are only
    // destroyed after indexing, which happens asynchronously so we can bulk
    // index items).
    beanstalkConnect(function(error, client) {
      if(!error) {
        this.beanstalkDestroyer = client;
      }

      asyncReadyCallback(error);
    }.bind(this));
  },

  handleConnections: function(error) {
    if(error) {
      logger.error({ err: error }, 'Log processor worker connections error');
      process.exit(1);
      return false;
    }

    // Create an async cargo queue to batch up the logs into groups of 250
    // records to utilize the ElasticSearch bulk indexing (rather than indexing
    // each record individually).
    this.cargo = async.cargo(this.processCargoTasks.bind(this), 250);

    // Every 5 seconds, call the cargo processor explicitly, to flush any
    // records (in case we don't hit the 250 size immediately).
    setInterval(this.cargo.process.bind(this.cargo), 5000);

    this.reserveJob();
    this.emit('ready');
  },

  reserveJob: function() {
    // Don't queue up any more local jobs if there's already 1000 items in the
    // local cargo queue.
    async.until(function() {
      return this.cargo.tasks.length < 1000;
    }.bind(this), function(callback) {
      setTimeout(callback, 500);
    }, function() {
      this.beanstalk.reserve(function(error, jobId, payload) {
        if(error) {
          logger.error({ err: error }, 'beanstalk reserve error');
          setImmediate(this.reserveJob.bind(this));
          return false;
        }

        var logId = payload.toString();
        this.processLog(jobId, logId, function(error) {
          if(error) {
            this.rescheduleFailedJob(error, jobId, logId, function() {
              this.reserveJob();
            }.bind(this));
          } else {
            this.reserveJob();
          }
        }.bind(this));
      }.bind(this));
    }.bind(this));
  },

  processLog: function(jobId, logId, callback) {
    logger.debug({ jobId: jobId, logId: logId }, 'Log Processor: processLog');
    async.waterfall([
      this.fetchLogData.bind(this, logId),
      this.parseLogData.bind(this, logId),
      this.checkForIncompleteLogs.bind(this, jobId, logId),
      this.cleanLogData.bind(this, logId),
      this.cargoQueueData.bind(this, jobId, logId),
      this.finishJob.bind(this, jobId),
    ], callback);
  },

  fetchLogData: function(id, callback) {
    this.redis.hgetall('log:' + id, callback);
  },

  parseLogData: function(id, log, callback) {
    if(log) {
      if(log.initial_router) {
        log.initial_router = JSON.parse(log.initial_router);
      }

      if(log.gatekeeper) {
        log.gatekeeper = JSON.parse(log.gatekeeper);
      }

      if(log.api_backend_router) {
        log.api_backend_router = JSON.parse(log.api_backend_router);
      }
    }

    logger.debug({ id: id, log: log }, 'Log Processor: parseLogData');
    callback(null, log);
  },

  checkForIncompleteLogs: function(jobId, logId, log, callback) {
    // If all the expected data is present, continue on in the processLog
    // chain.
    if(log && log.initial_router && log.gatekeeper && log.api_backend_router) {
      callback(null, log);

    // If the gatekeeper denied the request, then only the gatekeeper and
    // initial_router log data will be present, so continue on with
    // api_backend_router data missing.
    } else if(log && log.initial_router && log.gatekeeper && log.gatekeeper.gatekeeper_denied_code) {
      callback(null, log);

    // If gatekeeper and api_backend_router data are missing, and the response
    // was a 429, then that's a good indication that the user hit the
    // nginx-based rate limits, and the request never made it to the
    // gatekeeper. In this case we will continue on with only the
    // initial_router data, since don't want to keep retrying and piling up
    // logs in the queue if things are being overloaded.
    } else if(log && log.initial_router && !log.gatekeeper && !log.api_backend_router && log.initial_router.res_status === 429) {
      callback(null, log);

    // If gatekeeper and api_backend_router data are missing, and the response
    // was a 502, then that's a good indication that the gatekeeper is down. In
    // this case we will continue on with only the initial_router data. This is
    // an edge-case we hope to never encounter, but if we do, we don't want to
    // compound a server problem by piling up logs in the queue.
    } else if(log && log.initial_router && !log.gatekeeper && !log.api_backend_router && log.initial_router.res_status === 502) {
      callback(null, log);

    // If the response was a 499, then the client canceled the request before
    // the server responded. In this case, continue on with just initial_router
    // data present, since the other log data doesn't matter too much.
    } else if(log && log.initial_router && (!log.gatekeeper || !log.api_backend_router) && log.initial_router.res_status === 499) {
      callback(null, log);

    // If only the api_backend_router data is missing, but the response
    // indicates it's a cached response, then that probably indicates that
    // Varnish responsed with a cached request. In that case, missing
    // api_backend_router data is to be expected.
    } else if(log && log.initial_router && log.gatekeeper && !log.api_backend_router && log.initial_router.res_x_cache === 'HIT') {
      callback(null, log);

    // Otherwise, we might temporarily be missing some log data due to out of
    // order log processing (since the nginx logs come in via UDP, order is not
    // guaranteed). In this case, we'll fail this job a few times so it gets
    // retried later.
    } else {
      this.getFailedJobAttempts(jobId, logId, function(error, failedAttempts) {
        // If things still aren't working after 3 failed attempts (4 total
        // tries - so after exponential delays of 4 + 8 + 16 seconds), but we
        // do have the initial_router log data, go ahead and log the request to
        // the analytics db. Since the initial_router contains nearly all of
        // the details we're interested in logging, this just means we'll miss
        // out on some timer data (but getting it into the analytics db seems
        // more important).
        //
        // This can happen when identical requests come in at the same time and
        // get rolled up to 1 request to the API backend by Varnish (Varnish's
        // grace mode). In this case, we'll be missing the api_backend_router
        // details for all but 1 of those rolled up requests. So this isn't
        // necessarily something to worry about, but we'll log it for now
        // anyway.
        if(failedAttempts && failedAttempts >= 3 && log && log.initial_router) {
          var logLevel = 'info';
          var message = 'Log data incomplete - logging anyway';
          if(log.initial_router.res_status >= 500) {
            logLevel = 'error';
            message += ' - response status code indicated internal API Umbrella server error - are all API Umbrella server processess running?';
          }

          logger[logLevel]({ logId: logId, jobId: jobId, failedAttempts: failedAttempts, hasInitialRouterData: !!log.initial_router, hasGatekeeperData: !!log.gatekeeper, hasApiBackendRouterData: !!log.api_backend_router, responseStatus: log.initial_router.res_status }, message);
          callback(null, log);
        } else {
          callback('Incomplete log data');
        }
      }.bind(this));
    }
  },

  cleanLogData: function(id, log, callback) {
    logger.debug({ id: id }, 'Log Processor: cleanLogData');
    var combined = {};

    if(log.gatekeeper) {
      _.extend(combined, {
        api_key: log.gatekeeper.api_key,
        gatekeeper_denied_code: log.gatekeeper.gatekeeper_denied_code,
        internal_gatekeeper_time: log.gatekeeper.internal_gatekeeper_time,
        internal_response_time: log.gatekeeper.internal_response_time,
        user_email: log.gatekeeper.user_email,
        user_id: log.gatekeeper.user_id,
        user_registration_source: log.gatekeeper.user_registration_source,
      });
    }

    if(log.api_backend_router) {
      _.extend(combined, {
        backend_response_time: log.api_backend_router.res_time_backend * 1000,
      });
    }

    if(log.initial_router) {
      _.extend(combined, {
        request_accept: log.initial_router.req_accept,
        request_accept_encoding: log.initial_router.req_accept_encoding,
        request_at: moment.unix(log.initial_router.req_at_msec - log.initial_router.res_time).toISOString(),
        request_basic_auth_username: log.initial_router.req_basic_auth_username,
        request_connection: log.initial_router.req_connection,
        request_content_type: log.initial_router.req_content_type,
        request_host: log.initial_router.req_host,
        request_ip: log.initial_router.req_ip,
        request_method: log.initial_router.req_method,
        request_origin: log.initial_router.req_origin,
        request_referer: log.initial_router.req_referer,
        request_scheme: log.initial_router.req_scheme,
        request_size: log.initial_router.req_size,
        request_url: log.initial_router.req_scheme + '://' + log.initial_router.req_host + log.initial_router.req_uri,
        request_user_agent: log.initial_router.req_user_agent,
        response_age: log.initial_router.res_age,
        response_content_encoding: log.initial_router.res_content_encoding,
        response_content_length: log.initial_router.res_content_length,
        response_content_type: log.initial_router.res_content_type,
        response_server: log.initial_router.res_server,
        response_size: log.initial_router.res_size,
        response_status: log.initial_router.res_status,
        response_time: log.initial_router.res_time * 1000,
        response_transfer_encoding: log.initial_router.res_transfer_encoding,
      });

      // Similarly, try to fill in the user information from the nginx logs if
      // the gatekeeper logs aren't present for some reason. This is probably
      // most relevant when the user is hitting the high nginx rate limits, in
      // which case we definitely want to know what user it was.
      if(!combined.api_key) {
        var apiKey;
        for(var i = 0, len = this.apiKeyMethods.length; i < len; i++) {
          switch(this.apiKeyMethods[i]) {
          case 'header':
            apiKey = log.initial_router.req_api_key_header;
            break;
          case 'getParam':
            apiKey = log.initial_router.req_api_key_query;
            break;
          case 'basicAuthUsername':
            apiKey = log.initial_router.req_basic_auth_username;
            break;
          }

          if(apiKey) {
            break;
          }
        }

        if(apiKey) {
          combined.api_key = apiKey;
        }
      }

      if(combined.hasOwnProperty('backend_response_time')) {
        combined.proxy_overhead = log.initial_router.res_time_backend * 1000 - combined.backend_response_time;
      }
    }

    var errorMessage;
    if(!combined.request_url) {
      errorMessage = 'Log data did not contain expected request_url field.';
    } else if(!combined.request_at) {
      errorMessage = 'Log data did not contain expected request_at field.';
    }

    if(errorMessage) {
      logger.error('Log data error: ' + errorMessage);
      callback(errorMessage);
    } else {
      logCleaner.all(this.elasticSearch, combined, callback);
    }
  },

  cargoQueueData: function(jobId, id, log, callback) {
    this.cargo.push({ jobId: jobId, id: id, log: log });
    callback();
  },

  finishJob: function(jobId, callback) {
    // After queueing up a local cargo job (for bulk indexing), release this
    // job so that it can be deleted once the indexing completes (in beanstalk
    // jobs appear like they have to be released in order to delete). Schedule
    // with a 10 minute delay, so this job should usually be deleted after the
    // bulk indexing completes, but if anything goes wrong in indexing, it will
    // be retried again.
    logger.debug({ jobId: jobId }, 'Log Processor: finishJob');
    var priority = 0;
    var delay = 600;
    this.beanstalk.release(jobId, priority, delay, function(error) {
      if(error) {
        logger.error({ err: error }, 'beanstalk release error');
      }

      callback();
    });
  },

  processCargoTasks: function(tasks, callback) {
    var bulkInserts = [];
    var ids = [];
    var multi = this.redis.multi();
    for(var i = 0, len = tasks.length; i < len; i++) {
      var task = tasks[i];
      var id = task.id;
      var log = task.log;
      var index = 'api-umbrella-logs-write-' + moment(log.request_at).utc().format('YYYY-MM');

      ids.push('log:' + id);

      bulkInserts.push({
        index: {
          _index: index,
          _type: 'log',
          _id: id,
        },
      });
      bulkInserts.push(log);

      multi.del('log:' + id);
    }

    if(bulkInserts.length > 0) {
      logger.debug({ ids: ids }, 'Log Processor: Bulk inserting');
      this.elasticSearch.bulk({ body: bulkInserts }, function(error) {
        if(error) {
          logger.error({ err: error }, 'elasticsearch bulk index error');
          return callback();
        }

        logger.debug({ ids: ids }, 'Log Processor: Bulk deleting');
        multi.exec(function(error) {
          if(error) {
            logger.error({ err: error }, 'redis bulk delete error');
            return callback();
          }

          logger.debug({ ids: ids }, 'Log Processor: Deleting beanstalk jobs');
          async.eachSeries(tasks, function(task, eachCallback) {
            this.beanstalkDestroyer.destroy(task.jobId, function(error) {
              if(error) {
                logger.error({ err: error, id: task.id, jobId: task.jobId }, 'beanstalk destroy error');
              }

              eachCallback();
            }.bind(this));
          }.bind(this), callback);
        }.bind(this));
      }.bind(this));
    }
  },

  getFailedJobAttempts: function(jobId, logId, callback) {
    this.beanstalk.stats_job(jobId, function(error, stats) {
      if(error || !stats || (typeof stats.releases) !== 'number') {
        logger.error({ err: error, logId: logId, jobId: jobId }, 'Failed to fetch beanstalk stats');
        callback(null, undefined);
      } else {
        callback(null, stats.releases);
      }
    });
  },

  rescheduleFailedJob: function(failureReason, jobId, logId, callback) {
    this.getFailedJobAttempts(jobId, logId, function(error, failedAttempts) {
      if(error || failedAttempts === undefined) {
        logger.warn({ err: error, logId: logId, jobId: jobId, failedAttempts: failedAttempts }, 'Failed to fetch beanstalk job stats');

        // If we couldn't fetch the beanstalk job stats to determine the number
        // of determine the number of failures, fake a high-ish number of
        // failed attempts so we don't bury the job, but retry after sleeping
        // for a while (maybe beanstalk was temporarily down?).
        if(!failedAttempts) {
          failedAttempts = 8;
        }
      }

      if(failedAttempts >= 10) {
        logger.error({ failureReason: failureReason, logId: logId, jobId: jobId, failedAttempts: failedAttempts }, 'Log processing failed too many times - burying permanently');
        this.beanstalk.bury(jobId, 200, function(error) {
          if(error) {
            logger.error({ err: error }, 'beanstalk release error');
          }

          callback();
        });
      } else {
        // Exponential backoff for retry attempts.
        // Retry after 4, 8, 16, 32, 64, etc. seconds.
        var delayBackoff = 4; // 4 seconds
        var delay = Math.pow(2, failedAttempts) * delayBackoff;

        var logLevel = 'info';
        if(failedAttempts >= 3) {
          logLevel = 'warn';
        }

        logger[logLevel]({ failureReason: failureReason, logId: logId, jobId: jobId, failedAttempts: failedAttempts, delay: delay }, 'Log processing failed - scheduling retry');
        this.beanstalk.release(jobId, 100, delay, function(error) {
          if(error) {
            logger.error({ err: error }, 'beanstalk release error');
          }

          callback();
        });
      }
    }.bind(this));
  },

  close: function(callback) {
    if(this.beanstalk) {
      this.beanstalk.exit();
    }

    if(this.redis) {
      this.redis.quit();
    }

    if(callback) {
      callback(null);
    }
  },
});
