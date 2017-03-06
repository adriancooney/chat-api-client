import events from "events";

export default class Model extends events.EventEmitter {
    constructor(client) {
        super();

        this.client = client;
    }
}