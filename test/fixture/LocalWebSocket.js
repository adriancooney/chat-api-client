import createDebug from "debug";
import { EventEmitter } from "events";
import Promise from "bluebird";
import APIClient from "../../src/APIClient";

const debug = createDebug("tw-chat:test:local-socket");

export default class LocalWebSocket extends EventEmitter {
    readyState = 1;

    constructor() {
        super();
        debug("new local websocket", arguments);

        this.onAfter("newListener", eventName => {
            if(eventName === "open") this.emit("client:connected");
        });

        debug("await client connection");
        this.onAfter("client:connected", () => {
            debug("client connected");
            this.flow([
                this.dispatch("authentication.request"),
                this.receive("authentication.response"),
                this.dispatch("authentication.confirmation")
            ]);
        });

        this.on("client:incoming", frame => {
            console.log("INCOMING", frame);
            if(frame.name === "ping") {
                this.dispatch("pong", {}, {
                    nonce: frame.nonce
                });
            }
        });

        setTimeout(this.emit.bind(this, "open"), 10);
    }

    send(message) {
        debug("received incoming local frame", message);
        this.emit("client:incoming", JSON.parse(message));
    }

    flow(actions) {
        return Promise.mapSeries(actions, action => action());
    }

    dispatch(type, contents, overrides) {
        return () => Promise.resolve(this.message(createFrame(type, contents, overrides)));
    }    

    receive(type) {
        return () => new Promise((resolve, reject) => {
            debug("local socket awaiting frame of type: ", type);
            this.onAfter("client:incoming", frame => {
                if(frame.name === type) {
                    resolve(frame);
                } else {
                    reject(new Error(`Received incorrect frame: ${JSON.stringify(frame)}`));
                }
            });
        });
    }

    emit(...args) {
        setTimeout(() => super.emit(...args), 10);
    }

    onAfter(eventName, listener) {
        return super.on(eventName, (...args) => setTimeout(listener.bind(this, ...args), 10));
    }

    message(data) {
        debug("sending outgoing local frame", data);
        this.emit("message", JSON.stringify(data));
    }

    close() {
        debug("closing socket");
    }
}

function createFrame(type, contents, overrides) {
    return Object.assign(APIClient.createFrame(type, contents), overrides);
}