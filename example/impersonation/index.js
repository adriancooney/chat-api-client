import Promise from "bluebird";
import { zipObject } from "lodash";
import TeamworkChat, { HTTPError } from "../..";

runScript("Soccer Mondays!", `
    @adrian: hi guys.
    @dwight: what's the shtory hi
    @michael: not much, yourself?
`);

export function runScript(roomTitle, script) {
    // Split up the script into { handle, line }
    const lines = script.split("\n").filter(line => line.trim()).map(line => {
        line = line.trim().split(":");

        return {
            handle: line[0].substr(1),
            line: line[1].trim()
        }
    });

    // Log in as the admin user
    return TeamworkChat.fromAuth("http://1486461376533.teamwork.com", "nw3Ujj83Gcz76vcOEIitdti5rfsPW-120606").then(admin => {
        // Impersonate all the users involved in the script
        return [admin, Promise.all(lines.map(({ handle }) => admin.impersonateByHandle(handle)))];
    }).spread((admin, users) => {
        // Get the room from the API
        return admin.getRoomByTitle(roomTitle).then(room => {
            // Get the room for all the individual, logged in users
            return Promise.all(users.map(user => user.getRoom(room.id)));
        }).then(rooms => {
            // Map <handle>: <room>
            rooms = zipObject(users.map(user => user.handle), rooms);

            // Loop over each line and send the message to each room as each user
            return Promise.mapSeries(lines, ({ handle, line }) => {
                return rooms[handle].sendMessage(line);
            });
        }).finally(() => {
            // Close out the connections
            users.forEach(user => user.close());
        });
    }).catch(HTTPError, error => {
        return error.body().then(body => {
            console.error(error, body);
        });
    });
}