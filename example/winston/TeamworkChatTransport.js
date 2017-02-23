import Promise from "bluebird";
import winston, { Transport } from "winston";
import TeamworkChat from "../..";

export default class Chat extends Transport {
    name = "TeamworkChat";

    constructor(options) {
        super(options);

        this.level = options.level || "info";
        this.formatter = options.formatter || Chat.formatMessage;

        this.connection = {
            installation: options.installation,
            username: options.username,
            password: options.password,
            auth: options.auth
        };

        this.room = options.room;
    }

    getClient() {
        if(this.closed) return Promise.reject(new Error("Transport closed."));
        if(this.client) return Promise.resolve(this.client);

        const { installation, username, password, auth } = this.connection;

        return Promise.try(() => {
            if(auth) {
                return TeamworkChat.fromAuth(installation, auth);
            } else {
                return TeamworkChat.fromCredentials(installation, username, password);
            }
        }).then(chat => {
            return this.client = chat;
        });
    }

    log(level, msg, meta, callback) {
        this.getClient().then(chat => {
            return chat.getRoom(this.room);
        }).then(room => {
            room.sendMessage(this.formatter.call(null, level, msg, meta));
        }).then(callback, callback);
    }

    close() {
        this.getClient().then(chat => {
            this.closed = true;
            chat.close();
        });
    }

    static formatMessage(level, msg, meta) {
        return `**[${level}]** ${msg}`;
    }
}

winston.transports.TeamworkChat = TeamworkChat;