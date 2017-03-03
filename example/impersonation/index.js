import Promise from "bluebird";
import { zipObject } from "lodash";
import TeamworkChat, { HTTPError } from "../..";

runTranscript("General", `
    @adrian: @all how's those reports coming?
    @dwight: morning everybody
    @michael: where's my coffee?
    @michael: @dwight?
    @pam: I'll get it @michael
`);

export function runTranscript(roomTitle, script) {
    // Split up the script into { handle, line }
    const lines = script.split("\n").filter(line => line.trim()).map(line => {
        line = line.trim().split(":");

        return {
            handle: line[0].substr(1),
            line: line[1].trim()
        }
    });

    // Log in as the admin user
    return TeamworkChat.fromAuth("<installation>", "<auth>").then(admin => {
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