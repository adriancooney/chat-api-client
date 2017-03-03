import { EventEmitter } from "events";
import winston from "winston";

export default class Bot extends EventEmitter {
    static transports = winston.transports;
    
    constructor(chat) {
        super();
        
        if(this.constructor.name === "Bot") {
            throw new Error("Bot class is to be extended and not instantiated directly.");
        }

        this.chat = chat;
        this.log = new winston.Logger({
            transports: [
                new winston.transports.Console()
            ]
        });
    }

    start() {
        throw new Error(`${this.constructor.name} has not implemented \`start\`.`);
    }
}