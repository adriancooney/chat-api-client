import debug from "debug";
import TeamworkChat from "../src/TeamworkChat";
import APIClient from "../src/APIClient";

export const INSTALLATION = {
    protocol: "http:",
    hostname: "sunbeam.teamwork.dev",
    port: 5000
};

export const USERNAME = "donalin+dev1@gmail.com";
export const PASSWORD = "test";
export const localTeamworkChat = TeamworkChat.fromCredentials.bind(null, INSTALLATION, USERNAME, PASSWORD);
export const localAPIClient = APIClient.loginWithCredentials.bind(null, INSTALLATION, USERNAME, PASSWORD);

export function createFrame(name, contents) {
    return {
        name, contents,
        contentType: "object"
    };
}

export function createMessageFrame(overrides) {
    return createFrame("room.message.created", Object.assign({
        "id": 52,
        "body": "howya lad",
        "installationId": 1,
        "roomId": 1,
        "userId": 1,
        "type": "message",
        "editedAt": null,
        "createdAt": "2017-01-29T18:06:34.640Z",
        "containsSnippet": 0,
        "containsLink": 0,
        "file": {},
        "shard": 6
    }, overrides));
}

export function createUser(overrides) {
    return Object.assign({
        "lastActivityAt": "2017-01-29T19:18:25.000Z",
        "id": 1,
        "firstName": "Developers",
        "lastName": "Guy",
        "title": "",
        "email": "donalin+dev1@gmail.com",
        "updatedAt": "2017-01-26T15:37:50.000Z",
        "handle": "developers",
        "status": "online",
        "deleted": false,
        "roomId": null,
        "isCurrentUserAllowedToChatDirectly": true,
        "company": {
            "id": 1,
            "name": "Teamwork"
        }
    }, overrides);
}

export function createRoom(overrides) {
    return Object.assign({
        "id": 5,
        "title": null,
        "status": "active",
        "lastActivityAt": "2017-01-29T19:18:25.000Z",
        "lastViewedAt": "2017-01-29T19:18:23.000Z",
        "updatedAt": "2017-01-29T19:18:23.000Z",
        "creatorId": 1,
        "createdAt": "2017-01-29T19:18:23.000Z",
        "type": "private",
        "people": [ createUser() ]
    }, overrides);
}