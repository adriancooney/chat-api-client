import TeamworkChat from "../..";

// Soccer mondays bot: count who is playing and never again mess up the counts
// To add yourself to the attending list:
// 
//      Adrian: @bot count me in
//         Bot: @adrian, you're in
//      
// To list the attendees:
// 
//      Adrian: @bot how many?
//         Bot: There are 2 attending: Adrian, Chris
//         
// To start again:
// 
//      Adrian: @bot start over
//         Bot: @all count reset to 0

let attending = [];

TeamworkChat.fromCredentials("http://<installation host>", "<username>", "<password>").then(chat => {
    return chat.getRoomByTitle("Soccer Mondays!");
}).then(room => {
    // Listen for mentions to @bot inside the room
    room.on("message:mention", (message) => {
        // "@<bot> count me in!" to be added to the list
        if(message.content.match(/count me (out|in)/)) {
            const person = message.author;

            if(RegExp.$1 === "in") { // Count me in
                if(attending.includes(person.firstName)) {
                    return room.sendMessage(`@${person.handle}, you're already in`);
                }

                attending.push(person.firstName);
            } else { // Count me out
                attending = attending.filter(name => name !== person.firstName);
            }

            return room.sendMessage(`@${person.handle}, you're ${RegExp.$1}`);
        }

        // "@<bot> how many?" to get how many people attending
        if(message.content.match(/how many/))
            return room.sendMessage(
                attending.length ? 
                    `There ${attending.length === 1 ? "is" : "are"} ${attending.length} attending: ${attending.join(", ")}` :
                    "There is nobody attending."
            );

        // "@<bot> start over" to restart the count
        if(message.content.match(/start (?:again|over)/)) {
            attending = [];
            return room.sendMessage("@all count reset to 0");
        }
    });
});