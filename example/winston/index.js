import winston from "winston";
import TeamworkChat from "./TeamworkChatTransport";

// Add Chat as a Winston Transport for some pretty slick logging
const chat = winston.add(TeamworkChat, { 
    room: 3735,
    installation: "<installation>",
    auth: "<auth>"
});

for(var i = 0; i < 10; i++) {
    winston.log("info", `i = ${i}`);
}

setTimeout(() => {
    // Don't forget to close the connection to Teamwork Chat
    winston.remove(winston.transports.TeamworkChat);
}, 3000);