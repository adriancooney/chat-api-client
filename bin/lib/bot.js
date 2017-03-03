require("babel-register");
require("babel-polyfill");

const Promise = require("bluebird");
const fs = require("fs");
const TeamworkChat = require("../../src").default;

let bots;

function startBots(config) {
    return Promise.try(() => {
        const connection = config.connection;

        if(!connection) {
            throw new Error("Missing `connection` property on config.");
        }

        const { installation } = connection;

        if(connection.key) {
            return TeamworkChat.fromKey(installation, connection.key);
        } else if(connection.auth) {
            return TeamworkChat.fromAuth(installation, connection.auth);
        } else if(connection.username && config.password) {
            return TeamworkChat.fromCredentials(installation, connection.username, connection.password);
        } else {
            throw new Error("Unknown or invalid connection configuration.");
        }
    }).then(chat => {
        bots = Object.keys(config.modules).reduce((store, name) => {
            try {
                const bot = require(name).default;

                store[name] = {
                    bot: new bot(chat), 
                    config: config.modules[name]
                };

                return store;
            } catch(err) {
                console.error(err.stack);
                throw new Error(`Unknown module ${name}.`);
            }
        }, {});

        // Start the bots
        return Promise.all(Object.values(bots).map(({ bot, config }) => bot.start(config)));
    });
}

function gracefullyExit() {
    return Promise.all(
        Object.values(bots).map(({ bot }) => {
            // Flush the bot's loggers
            return new Promise((resolve, reject) => {
                bot.log.on("error", reject);
                bot.log.on("close", resolve);
                bot.log.close();
            }).then(() => {
                // Stop the bot
                return bot.stop();
            });
        })
    ).then(() => process.exit(1));
}

function readConfig() {
    return require(process.argv[2]);
}

function fatal(error) {
    process.stderr.write(error.stack);
    process.exit(1);
}

process.on("SIGUSR1", () => gracefullyExit().catch(fatal));
startBots(readConfig()).catch(fatal);