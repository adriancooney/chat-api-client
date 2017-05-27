import winston from "winston";
import { omit, isEmpty } from "lodash";
import { indent } from "../util";

// Props on the root level meta object that we hide
const HIDDEN_META_PROPS = ["auth", "installation", "handle"];

// Set the default level to info unless DEBUG set
const level = winston.level = process.env.DEBUG_LEVEL || "debug";

const colors = ["yellow", "green", "magenta", "cyan", "blue", "red", "grey", "cyan"];

// Just add some colors so we can use Winstons colors and it's ability
// to turn off color output when logging to files
winston.config.addColors(colors.reduce((c, cs) => Object.assign(c, { [cs]: cs }), {}));

let pointer = 0;
const colorMap = {};
const getColorizer = () => winston.config.colorize.bind(null, colors[pointer < colors.length - 1 ? pointer++ : pointer = 0]);
const colorize = (id, text) => (colorMap[id] ? colorMap[id] : colorMap[id] = getColorizer())(text);

const options = {
    transports: [
        new winston.transports.File({
            level: "debug",
            filename: "twchat.log",
            // Winston is a piece of shit.
            json: true,
            stringify: JSON.stringify
        }),

        new winston.transports.Console({
            level,
            formatter: (options) => {
                let output = `${winston.config.colorize(level, level)}: ${options.message}`;

                if(options.meta) {
                    const meta = omit(options.meta, ...HIDDEN_META_PROPS);

                    if(!isEmpty(meta)) {
                        output += `\n\n${indent(JSON.stringify(meta, null, 2))}\n`;
                    }
                }

                return output;
            }
        })
    ]
};

const container = new winston.Container(options);

// The options for out loggers
const defaults = {
    filters: [
        // We add the prefix to the logs
        (level, msg, meta, logger) =>`${colorize(logger.id, `[${logger.id}]`)} ${msg}`
    ],

    rewriters: [
        (level, msg, meta, logger) => Object.assign(meta, logger.meta)
    ]
};

// Override container.add to allow us to add rewriters/filters
container.add = function(name, options = {}) {
    const logger = winston.Container.prototype.add.call(container, name, omit(options, "rewriters", "filters", "meta"));
    Object.assign(logger, defaults, options);
    return logger;
};

export default container;