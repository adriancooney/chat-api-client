import { EventEmitter } from "events";

export default class WildEventEmitter extends EventEmitter {
    emit(eventName, ...args) {
        // Emit the "*" any time an event is called
        EventEmitter.prototype.emit.apply(this, ["*", eventName].concat(args));
        
        return super.emit(eventName, ...args);
    }
}