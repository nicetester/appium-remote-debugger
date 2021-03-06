import log from './logger';
import { REMOTE_DEBUGGER_PORT } from './remote-debugger';
import getRemoteCommand from './remote-messages';
import WebSocket from 'ws';
import Promise from 'bluebird';
import _ from 'lodash';
import events from 'events';
import { simpleStringify } from './helpers';


export default class WebKitRpcClient extends events.EventEmitter {
  constructor (host, port = REMOTE_DEBUGGER_PORT) {
    super();

    this.host = host;
    this.port = port;

    this.curMsgId = 0;

    this.dataHandlers = {};
    this.dataMethods = {};
    this.errorHandlers = {};

    this.setHandlers();
  }

  async connect (pageId) {
    return new Promise(async (resolve, reject) => {
      // we will only resolve this call when the socket is open
      // WebKit url
      let url = `ws://${this.host}:${this.port}/devtools/page/${pageId}`;
      this.pageIdKey = pageId;

      // create and set up socket with appropriate event handlers
      this.socket = new WebSocket(url);
      this.socket.on('open', () => {
        log.debug(`WebKit debugger web socket connected to url: ${url}`);
        this.connected = true;
        resolve();
      });
      this.socket.on('close', () => {
        log.debug('WebKit remote debugger socket disconnected');
        this.connected = false;
      });
      this.socket.on('error', (exception) => {
        if (this.connected) {
          log.debug(`WebKit debugger web socket error: ${exception.message}`);
          this.connected = false;
        }

        reject(exception);
      });
      this.socket.on('message', this.receive.bind(this));
    });
  }

  disconnect () {
    log.debug('Disconnecting from WebKit remote debugger');
    if (this.isConnected()) {
      this.socket.close(1001);
    }
    this.connected = false;
  }

  isConnected () {
    return (this.socket !== null && this.connected);
  }


  async send (command, opts = {}) {
    let data = getRemoteCommand(command, _.defaults({connId: this.connId, senderId: this.senderId}, opts));

    log.debug(`Sending WebKit data: ${_.truncate(JSON.stringify(data), 50)}`);

    this.curMsgId++;
    data.id = this.curMsgId;

    let id = this.curMsgId.toString();
    return new Promise(async (resolve, reject) => {
      // only resolve the send command when WebKit returns a response
      // store the handler and the data sent
      this.dataHandlers[id] = resolve;
      this.dataMethods[id] = data.method;
      this.errorHandlers[id] = reject;

      // send the data
      data = JSON.stringify(data);
      this.socket.send(data, function (error) {
        if (!_.isUndefined(error) && !_.isNull(error)) {
          log.debug(`WebKit socket error occurred: ${error}`);
          reject(new Error(error));
        }
      });
    }).then((res) => {
      // no need to hold onto anything
      delete this.dataHandlers[id];
      delete this.dataMethods[id];
      delete this.errorHandlers[id];

      // and pass along the result
      return res;
    });
  }


  receive (data) {
    log.debug(`Receiving WebKit data: ${_.truncate(data, 50)}`);

    data = JSON.parse(data);

    // we can get an error, or we can get a response that is an error
    if (data.wasThrown) {
      let message = data.result.value || data.result.description;
      let error = new Error(message);
      if (data.id && this.errorHandlers[data.id]) {
        this.errorHandlers[data.id](error);
        return;
      } else {
        // this should never happen, but log at least
        log.errorAndThrow(error);
      }
    }

    // when sending we set a data method and associated callback.
    // get that, or the generic (automatically sent, not associated
    // with a particular request) method
    let handlerFor;
    if (data.id && this.dataMethods[data.id]) {
      log.debug(`Found handler for message '${data.id}'`);
      handlerFor = this.dataMethods[data.id];
    } else {
      log.debug(`Did not find handler for message`);
      handlerFor = data.method;
    }

    if (!handlerFor) {
      log.debug(`Received an invalid method: ${data.method}`);
      return;
    }
    if (_.has(this.handlers, handlerFor)) {
      this.handlers[handlerFor](data);
    } else {
      log.debug(`WebKit debugger got a message for '${handlerFor}' ` +
                `and have no handler, doing nothing.`);
    }
  }

  setHandlers () {
    this.handlers = {
      'Runtime.evaluate': (data) => {
        let msgId = data.id;
        if (data.error) {
          this.errorHandlers[msgId](data.error);
        }

        this.dataHandlers[msgId](data.result);
      },
      'Page.navigate': (data) => {
        log.debug(`Received page navigated message: ${simpleStringify(data)}`);
        let msgId = data.id;
        if (data.error) {
          this.errorHandlers[msgId](data.error);
        }

        this.dataHandlers[msgId](data.result);
      },
      'Profiler.resetProfiles': () => {
        log.debug('Device is telling us to reset profiles. Should probably ' +
                  'do some kind of callback here');
      },
      'Timeline.eventRecorded': (data) => {
        this.timelineEventHandler(data.result);
      }
    };
  }


  setTimelineEventHandler (timelineEventHandler) {
    this.timelineEventHandler = timelineEventHandler;
    this.messageHandler.setTimelineEventHandler(timelineEventHandler);
  }
}
