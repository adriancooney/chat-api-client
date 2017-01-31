import { EventEmitter } from "events";

export default class WildEventEmitter extends EventEmitter {
    emit(eventName, ...args) {
        EventEmitter.prototype.emit.apply(this, ["*", eventName].concat(args));
        return super.emit(eventName, ...args);
    }

    on(eventName, ...args) {
        if(this.listenerCount(eventName) > this.getMaxListeners()) {
            console.log("EE MEMORY LEAK", this, eventName);
            console.trace();
        }

        super.on(eventName, ...args);
    }
}