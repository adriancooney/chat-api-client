import Promise from "bluebird";
import program from "commander";
import createDebug from "debug";
import rc from "rc";

const config = rc("tw-chat");
const debug = createDebug("tw-chat:config");

export function getUser(target = config.user) {
    if(!config.config)
        throw new Error("No `.tw-chatrc` configuration file found!");

    const user = config.users[target];

    if(!user)
        throw new Error(`User "${target}" not found.`);

    return [user.installation, user.username, user.password];
}

export function fail(error) {
    console.error(error);
    process.exit(1);
}

export function command(callback) {
    // Some default progam options
    // Allow configuration via command line arguments with `rc`.
    program.allowUnknownOption();

    return Promise.try(callback.bind(null, program, config)).catch(fail);
}