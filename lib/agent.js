// This implements the network API for ShareJS.
//
// The wire protocol is speccced out here:
// https://github.com/josephg/ShareJS/wiki/Wire-Protocol
//
// When a client connects the server first authenticates it and sends:
//
// S: {id:<agent clientId>}
//
// After that, the client can open documents:
//
// C: {c:'users', d:'fred', sub:true, snapshot:null, create:true, type:'text'}
// S: {c:'users', d:'fred', sub:true, snapshot:{snapshot:'hi there', v:5, meta:{}}, create:false}
//
// ...
//
// The client can send open requests as soon as the socket has opened - it doesn't need to
// wait for its id.
//
// The wire protocol is documented here:
// https://github.com/josephg/ShareJS/wiki/Wire-Protocol
//

var async = require('async');
var hat = require('hat');
var util = require('./util');

/**
 * Agent deserializes the wire protocol messages received from the stream and
 * calls the corresponding functions on its Agent. It uses the return values
 * to send responses back. Agent also handles piping the operation streams
 * provided by a Agent.
 *
 * @param {Backend} backend
 * @param {Duplex} stream connection to a client
 */
function Agent(backend, stream) {
  // The stream passed in should be a nodejs 0.10-style stream.
  this.backend = backend;
  this.stream = stream;

  this.clientId = hat();
  this.connectTime = Date.now();

  // We need to track which documents are subscribed by the client. This is a
  // map of collection -> id -> stream
  this.subscribedDocs = {};

  // Map from queryId -> emitter
  this.subscribedQueries = {};

  // Subscriptions care about the stream being destroyed. We end up with a
  // listener per subscribed document for the client, which can be a lot.
  stream.setMaxListeners(0);

  // We need to track this manually to make sure we don't reply to messages
  // after the stream was closed. There's no built-in way to ask a stream
  // whether its actually still open.
  this.closed = false;

  var agent = this;
  stream.once('end', function() {
    agent._cleanup();
  });

  // Initialize the remote client by sending it its agent Id.
  this._send({a: 'init', protocol: 0, id: this.clientId});
}
module.exports = Agent;

// Close the agent with the client.
Agent.prototype.close = function(err) {
  if (err) {
    console.warn('Agent closed due to error', err);
    this.stream.emit('error', err);
  }
  if (this.closed) return;
  // This will emit 'end', which will call _cleanup
  this.stream.end();
};

Agent.prototype._cleanup = function() {
  if (this.closed) return;
  this.closed = true;

  // Remove the pump listener
  this.stream.removeAllListeners('readable');

  // Clean up all the subscriptions.
  for (var collection in this.subscribedDocs) {
    var docs = this.subscribedDocs[collection];
    for (var id in docs) {
      var stream = docs[id];
      stream.destroy();
    }
  }
  // Cancel the subscribes
  this.subscribedDocs = {};

  for (var id in this.subscribedQueries) {
    var emitter = this.subscribedQueries[id];
    emitter.destroy();
  }
  // Cancel the subscribes
  this.subscribedQueries = {};
};

/**
 * Passes operation data received on stream to the agent stream via
 * _sendOp()
 */
Agent.prototype._subscribeToStream = function(collection, id, stream) {
  if (this.closed) return stream.destroy();

  var streams = this.subscribedDocs[collection] || (this.subscribedDocs[collection] = {});

  // If already subscribed to this document, destroy the previously subscribed stream
  var previous = streams[id];
  if (previous) previous.destroy();
  streams[id] = stream;

  var agent = this;
  stream.on('data', function(data) {
    if (data.error) {
      // Log then silently ignore errors in a subscription stream, since these
      // may not be the client's fault, and they were not the result of a
      // direct request by the client
      console.error('Doc subscription stream error', collection, id, data.error);
      return;
    }
    if (agent._isOwnOp(collection, data)) return;
    agent._sendOp(collection, id, data);
  });
  stream.on('end', function() {
    // Livedb has closed the op stream, so release its reference
    var streams = agent.subscribedDocs[collection];
    if (!streams) return;
    delete streams[id];
    if (util.hasKeys(streams)) return;
    delete agent.subscribedDocs[collection];
  });
};

Agent.prototype._subscribeToQuery = function(emitter, queryId, collection, query) {
  if (this.closed) return emitter.destroy();

  var previous = this.subscribedQueries[queryId];
  if (previous) previous.destroy();
  this.subscribedQueries[queryId] = emitter;

  var agent = this;
  emitter.onExtra = function(extra) {
    agent._send({a: 'q', id: queryId, extra: extra});
  };

  emitter.onDiff = function(diff) {
    for (var i = 0; i < diff.length; i++) {
      var item = diff[i];
      if (item.type === 'insert') {
        item.values = getResultsData(item.values);
      }
    }
    // Consider stripping the collection out of the data we send here
    // if it matches the query's collection.
    agent._send({a: 'q', id: queryId, diff: diff});
  };

  emitter.onError = function(err) {
    // Log then silently ignore errors in a subscription stream, since these
    // may not be the client's fault, and they were not the result of a
    // direct request by the client
    console.error('Query subscription stream error', collection, query, err);
  };

  emitter.onOp = function(op) {
    var id = op.d;
    if (agent._isOwnOp(collection, op)) return;
    agent._sendOp(collection, id, op);
  };
};

Agent.prototype._isOwnOp = function(collection, op) {
  // Detect ops from this client on the same projection. Since the client sent
  // these in, the submit reply will be sufficient and we can silently ignore
  // them in the streams for subscribed documents or queries
  return this.clientId === op.src && collection === (op.i || op.c);
};

Agent.prototype._send = function(msg) {
  // Quietly drop replies if the stream was closed
  if (this.closed) return;

  this.stream.write(msg);
};

Agent.prototype._sendOp = function(collection, id, op) {
  var msg = {
    a: 'op',
    c: collection,
    d: id,
    v: op.v,
    src: op.src,
    seq: op.seq
  };
  if (op.op) msg.op = op.op;
  if (op.create) msg.create = op.create;
  if (op.del) msg.del = true;

  this._send(msg);
};

Agent.prototype._reply = function(req, err, msg) {
  var msg = (err) ? {error: err} : msg || {};

  msg.a = req.a;
  if (req.c) msg.c = req.c;
  if (req.d) msg.d = req.d;
  if (req.id) msg.id = req.id;

  this._send(msg);
};

// start processing events from the stream. This calls itself recursively.
// Use .close() to drain the pump.
Agent.prototype.pump = function() {
  if (this.closed) return;

  var req = this.stream.read();
  var agent = this;
  if (req == null) {
    // Retry when there's a message waiting for us.
    this.stream.once('readable', function() {
      agent.pump();
    });
    return;
  }
  if (typeof req === 'string') {
    try {
      req = JSON.parse(req);
    } catch(e) {
      console.warn('Client sent invalid JSON', e.stack);
      this.close(e);
    }
  }
  this._handleMessage(req);
  // Clean up the stack then read the next message
  process.nextTick(function() {
    agent.pump();
  });
};

// Check a request to see if its valid. Returns an error if there's a problem.
Agent.prototype._checkRequest = function(req) {
  if (req.a === 'qsub' || req.a === 'qfetch'  || req.a === 'qunsub' || req.a === 'qresub') {
    // Query messages need an ID property.
    if (typeof req.id !== 'number') return 'Missing query ID';
  } else if (req.a === 'op' || req.a === 'sub' || req.a === 'unsub' || req.a === 'fetch') {
    // Doc-based request.
    if (req.c != null && typeof req.c !== 'string') return 'Invalid collection';
    if (req.d != null && typeof req.d !== 'string') return 'Invalid id';

    if (req.a === 'op') {
      if (req.v != null && (typeof req.v !== 'number' || req.v < 0)) return 'Invalid version';
    }
  } else if (req.a === 'bs') {
    // Bulk subscribe
    if (typeof req.s !== 'object') return 'Invalid bulk subscribe data';
  } else {
    return 'Invalid action';
  }
};

// Handle an incoming message from the client
Agent.prototype._handleMessage = function(req) {
  var agent = this;
  var callback = function(err, message) {
    agent._reply(req, err, message);
  };

  var errMessage = this._checkRequest(req);
  if (errMessage) return callback({code: 4000, message: errMessage});

  switch (req.a) {
    case 'qsub':
      return this._querySubscribe(req, callback);
    case 'qresub':
      return this._queryResubscribe(req, callback);
    case 'qunsub':
      return this._queryUnsubscribe(req, callback);
    case 'qfetch':
      return this._queryFetch(req, callback);
    case 'bs':
      return this._bulkSubscribe(req, callback);
    case 'sub':
      return this._subscribe(req, callback);
    case 'unsub':
      return this._unsubscribe(req, callback);
    case 'fetch':
      return this._fetch(req, callback);
    case 'op':
      return this._submit(req, callback);
    default:
      callback({
        code: 4000,
        message: 'Invalid or unknown message'
      });
  }
};

function getQueryOptions(req) {
  return {
    versions: req.vs,
    db: req.db
  };
}

Agent.prototype._queryResubscribe = function(req, callback) {
  var queryId = req.id;

  var query = req.q;

  var emitter = this.subscribedQueries[queryId];

  if (!emitter) return callback({message: 'Can not find query to resubscribe'});

  var index = emitter.index;
  var options = emitter.options;

  this.backend.queryResubscribe(this, index, query, emitter, options, function(err) {
    if (err) return callback(err);
    process.nextTick(callback);
  });
};

Agent.prototype._querySubscribe = function(req, callback) {
  // Subscribe to a query. The client is sent the query results and its
  // notified whenever there's a change
  var queryId = req.id;
  var collection = req.c;
  var query = req.q;
  var options = getQueryOptions(req);
  var agent = this;
  this.backend.querySubscribe(this, collection, query, options, function(err, emitter, results, extra) {
    if (err) return callback(err);
    agent._subscribeToQuery(emitter, queryId, collection, query);
    agent._sendQueryResults(queryId, collection, options, results, extra, callback);
  });
};

Agent.prototype._queryUnsubscribe = function(req, callback) {
  var queryId = req.id;
  var emitter = this.subscribedQueries[queryId];
  if (emitter) {
    emitter.destroy();
    delete this.subscribedQueries[queryId];
  }
  process.nextTick(callback);
};

Agent.prototype._queryFetch = function(req, callback) {
  // Fetch the results of a query once
  var queryId = req.id;
  var collection = req.c;
  var query = req.q;
  var options = getQueryOptions(req);
  var agent = this;
  this.backend.queryFetch(this, collection, query, options, function(err, results, extra) {
    if (err) return callback(err);
    agent._sendQueryResults(queryId, collection, options, results, extra, callback);
  });
};

Agent.prototype._sendQueryResults = function(queryId, collection, options, results, extra, callback) {
  var versions = options.versions;
  var data = getResultsData(results, versions);
  var res = {id: queryId, data: data, extra: extra};
  var opsRequest = getResultsOpsRequest(results, versions);
  if (!opsRequest) return callback(null, res);
  var agent = this;
  this.backend.getOpsBulk(this, collection, opsRequest, null, function(err, results) {
    if (err) return callback(err);
    for (var id in results) {
      var ops = results[id];
      for (var i = 0; i < ops.length; i++) {
        agent._sendOp(collection, id, ops[i]);
      }
    }
    callback(null, res);
  });
};
function getResultsData(results, versions) {
  var items = [];
  var lastType = null;
  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    var item = {d: result.id, v: result.v};
    if (lastType !== result.type) {
      lastType = item.type = result.type;
    }
    if (!versions || versions[result.id] == null) {
      item.data = result.data;
    }
    items.push(item);
  }
  return items;
}
function getResultsOpsRequest(results, versions) {
  if (!versions) return;
  var request;
  for (var i = 0; i < results.length; i++) {
    var result = results[i];
    var from = versions[result.id];
    if (from != null && result.v > from) {
      if (!request) request = {};
      request[result.id] = from;
    }
  }
  return request;
}

// Bulk subscribe. The message is:
// {a:'bs', s:{users:{fred:100, george:5, carl:null}}}
Agent.prototype._bulkSubscribe = function(req, callback) {
  var request = req.s;
  var response = {};

  var agent = this;
  async.forEachOf(request, function(versions, collection, eachCb) {
    agent.backend.subscribeBulk(agent, collection, versions, function(err, streams, snapshotMap) {
      if (err) return eachCb(err);
      for (var id in streams) {
        agent._subscribeToStream(collection, id, streams[id]);
        // Give a thumbs up for the subscription
        if (!snapshotMap[id]) snapshotMap[id] = true;
      }
      response[collection] = snapshotMap;
      eachCb();
    });
  }, function(err) {
    if (err) {
      // Close any streams we may have already subscribed before erroring to
      // avoid leaking memory if earlier calls to backend.subscribeBulk succeed
      // and others fail
      for (var collection in request) {
        var docs = agent.subscribedDocs[collection];
        if (!docs) continue;
        for (var id in request[collection]) {
          var stream = docs[id];
          if (stream) stream.destroy();
        }
      }
      return callback(err);
    }
    callback(null, {s: response});
  });
};

Agent.prototype._subscribe = function(req, callback) {
  // Subscribe to a document
  var collection = req.c;
  var id = req.d;
  var version = req.v;

  // If the version is specified, catch the client up by sending all ops
  // since the specified version
  var agent = this;
  this.backend.subscribe(this, collection, id, version, function(err, stream, data) {
    if (err) return callback(err);
    agent._subscribeToStream(collection, id, stream);
    // Snapshot data is returned only when subscribing from a null version.
    // Otherwise, ops will have been pushed into the stream
    if (data) {
      callback(null, {data: data});
    } else {
      callback();
    }
  });
};

Agent.prototype._unsubscribe = function(req, callback) {
  // Unsubscribe from the specified document. This cancels the active
  // stream or an inflight subscribing state
  var collection = req.c;
  var id = req.d;
  var docs = this.subscribedDocs[collection];
  var stream = docs && docs[id];
  if (stream) stream.destroy();
  process.nextTick(callback);
};

Agent.prototype._fetch = function(req, callback) {
  var collection = req.c;
  var id = req.d;
  var version = req.v;
  if (version == null) {
    // Fetch a snapshot
    this.backend.fetch(this, collection, id, function(err, data) {
      if (err) return callback(err);
      callback(null, {data: data});
    });
  } else {
    // It says fetch on the tin, but if a version is specified the client
    // actually wants me to fetch some ops
    var agent = this;
    this.backend.getOps(this, collection, id, version, null, function(err, results) {
      if (err) return callback(err);
      for (var i = 0; i < results.length; i++) {
        agent._sendOp(collection, id, results[i]);
      }
      callback();
    });
  }
};

Agent.prototype._submit = function(req, callback) {
  var collection = req.c;
  var id = req.d;
  var op = this._createOp(req);
  var agent = this;
  this.backend.submit(this, collection, id, op, function(err, ops) {
    // Message to acknowledge the op was successfully submitted
    var ack = {src: op.src, seq: op.seq, v: op.v};
    if (err) {
      // Occassional 'Op already submitted' errors are expected to happen as
      // part of normal operation, since inflight ops need to be resent after
      // disconnect. In this case, ack the op so the client can proceed
      if (err.code === 4001) return callback(null, ack);
      return callback(err);
    }

    // Reply with any operations that the client is missing.
    for (var i = 0; i < ops.length; i++) {
      agent._sendOp(collection, id, ops[i]);
    }
    callback(null, ack);
  });
};

function CreateOp(src, seq, v, create) {
  this.src = src;
  this.seq = seq;
  this.v = v;
  this.create = create;
  this.m = null;
}
function EditOp(src, seq, v, op) {
  this.src = src;
  this.seq = seq;
  this.v = v;
  this.op = op;
  this.m = null;
}
function DeleteOp(src, seq, v, del) {
  this.src = src;
  this.seq = seq;
  this.v = v;
  this.del = del;
  this.m = null;
}
// Normalize the properties submitted
Agent.prototype._createOp = function(req) {
  // src can be provided if it is not the same as the current agent,
  // such as a resubmission after a reconnect, but it usually isn't needed
  var src = req.src || this.clientId;
  if (req.op) {
    return new EditOp(src, req.seq, req.v, req.op);
  } else if (req.create) {
    return new CreateOp(src, req.seq, req.v, req.create);
  } else if (req.del) {
    return new DeleteOp(src, req.seq, req.v, req.del);
  }
};
