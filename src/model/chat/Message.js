import moment from "moment";
import { omit } from "lodash";

export default class Message {
    /** @type {String} The message content. */
    content;

    /** @type {Number} The message id. */
    id;

    /** @type {Number} The room ID of the message. */
    roomId;

    /** @type {Number} The author's ID. */
    userId;

    /**
     * The "status" of a message. It can contain one of two values (I've found):
     * 
     *   - "active" - Message is unchanged.
     *   - "redacted" - Message has been removed.
     *     
     * @type {String}
     */
    status;

    /** @type {Object} The message's file information. */
    file;

    /** @type {moment} The timestamp the message was created at. */
    createdAt;

    /** @type {Array} Array of data describing third party cards. */
    thirdPartyCards;

    /** @type {Boolean} Flag whether the user's account who created the message still exists. */
    isUserActive;

    /**
     * Create a new Message.
     * 
     * @param  {Object} details Optional, passed to #update. See Message#update.
     * @return {Message}
     */
    constructor(details) {
        if(typeof details === "string")
            details = { body: details };

        this.update(details);
    }

    /**
     * Update the message's details and do type conversions on the data.
     * @param  {Object} details Message object returned from server.
     * @return {Message}         The current message instance.
     */
    update(details = {}) {
        return Object.assign(this, omit(details, "body", "createdAt"), {
            content: details.body,
            createdAt: moment(details.createdAt)
        });
    }

    /**
     * Convert to usable string output for `console.log`.
     * @return {String}
     */
    inspect() {
        return `Message{id = ${this.id}, "${this.content}"}`;
    }
}