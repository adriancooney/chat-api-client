import os from "os";
import fs from "fs";
import path from "path";
import Promise from "bluebird";
import program from "commander";
import createDebug from "debug";
import rc from "rc";
import { unionBy } from "lodash";
import TeamworkChat from "../..";

export const CACHE_PATH = path.join(os.homedir(), ".twchatcache");

const config = rc("tw-chat");
const debug = createDebug("tw-chat:config");

Promise.promisifyAll(fs);

/** @type {TeamworkChat} The TeamworkChat instance (if any). */
let chatInstance = null;

export function getUser(target = config.user) {
    if(!config.config)
        throw new Error("No `.tw-chatrc` configuration file found!");

    const user = config.users[target];

    if(!user)
        throw new Error(`User "${target}" not found.`);

    return [user.installation, user.username, user.password];
}

function saveCache(cache = {}) {
    debug(`saving cache to ${CACHE_PATH}`);
    return fs.writeFileAsync(CACHE_PATH, JSON.stringify(cache, null, 2)).catch(err => {
        throw new Error("Unable to save cache.");
    });
}

function loadCache(defaultCache) {
    return Promise.try(() => {
        debug(`loading cache from ${CACHE_PATH}`);
        return fs.readFileAsync(CACHE_PATH, { encoding: "utf8" });
    }).then(cache => {
        return JSON.parse(cache);
    }).catch(err => {
        if(defaultCache) {
            return defaultCache;
        } else {
            throw new Error("Unable to load cache.");
        }
    });
}

function clearCache() {
    return fs.unlinkAsync(CACHE_PATH);
}

function chatFromCache() {
    return loadCache().then((cache = {}) => {
        const { 
            user: { api: { installation, auth } },
            rooms, people
        } = cache[config.user];

        return TeamworkChat.fromAuth(installation, auth).tap(chat => {
            // It's not imperative if the following calls complete successfully but it
            // is imperative that we catch an errors occurring. If we don't, we leave
            // a hanging TeamworkChat instance connected with an open socket and that's not good. 
            return Promise.try(() => {
                people.forEach(chat.savePerson.bind(chat));
                rooms.forEach(chat.saveRoom.bind(chat));
            }).catch(err => {
                debug(`error loading people and rooms data from cache`, err);
            });
        });
    });
}

function cacheFromChat(chat) {
    return loadCache({}).then(cache => Object.assign(cache, {
        [config.user]: {
            user: chat,
            rooms: unionBy(chat.rooms, cache.rooms, "id"),
            people: unionBy(chat.people, cache.people, "id")
        }
    }));
}

export function getChat(user) {
    if(chatInstance)
        return Promise.resolve(chatInstance);

    return chatFromCache().catch(err => {
        debug("unable to load chat login details from auth, re-authenticating");

        return TeamworkChat.fromCredentials(...getUser(user));
    }).tap(chat => chatInstance = chat);
}

export function command(callback) {
    // Some default progam options
    // Allow configuration via command line arguments with `rc`.
    program.allowUnknownOption();

    return Promise.try(callback.bind(null, program, config)).finally(() => {
        if(chatInstance) {
            chatInstance.close();
        }
    }).then(() => {
        if(chatInstance) {
            return cacheFromChat(chatInstance).then(saveCache);
        }
    }).catch(fail);
}

export function fail(error) {
    console.log("Command failed:");
    console.error(error.stack);
    process.exit(1);
}