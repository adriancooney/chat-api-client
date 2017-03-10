# Weird API Points
- Room.sendMessage has a `forceCreate` function that allows you to create the room on the server side. This is an entirely different room from instance the function is acting on and doesn't make sense.

> Fixed. Removed `forceCreate` parameter as it isn't used.