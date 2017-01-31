import { omit } from "lodash";

export default class Message {
    /** @type {String} The message content. */
    content;

    constructor(details) {
        if(typeof details === "string")
            details = { body: details };

        this.update(details);
    }

    update(details = {}) {
        return Object.assign(this, omit(details, "body"), {
            content: details.body
        });
    }

    inspect() {
        return `Message{id = ${this.id}, "${this.content}"}`;
    }
}