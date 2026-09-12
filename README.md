# Battlesnake JavaScript Starter Project

An official Battlesnake template written in JavaScript. Get started at [play.battlesnake.com](https://play.battlesnake.com).

![Battlesnake Logo](https://media.battlesnake.com/social/StarterSnakeGitHubRepos_JavaScript.png)

This project is a great starting point for anyone wanting to program their first Battlesnake in JavaScript. It can be run locally or easily deployed to a cloud provider of your choosing. See the [Battlesnake API Docs](https://docs.battlesnake.com/api) for more detail. 

[![Run on Replit](https://repl.it/badge/github/BattlesnakeOfficial/starter-snake-javascript)](https://replit.com/@Battlesnake/starter-snake-javascript)

## Technologies Used

This project uses [Node.js](https://nodejs.dev/) and [Express](https://expressjs.com/). It also comes with an optional [Dockerfile](https://docs.docker.com/engine/reference/builder/) to help with deployment.

## Run Your Battlesnake

Install dependencies using npm

```sh
npm install
```

Start your Battlesnake

```sh
npm run start
```

You should see the following output once it is running

```sh
Running Battlesnake at http://0.0.0.0:8000
```

Open [localhost:8000](http://localhost:8000) in your browser and you should see

```json
{"apiversion":"1","author":"","color":"#888888","head":"default","tail":"default"}
```

## Play a Game Locally

Install the [Battlesnake CLI](https://github.com/BattlesnakeOfficial/rules/tree/main/cli)
* You can [download compiled binaries here](https://github.com/BattlesnakeOfficial/rules/releases)
* or [install as a go package](https://github.com/BattlesnakeOfficial/rules/tree/main/cli#installation) (requires Go 1.18 or higher)

Command to run a local game

```sh
battlesnake play -W 11 -H 11 --name 'JavaScript Starter Project' --url http://localhost:8000 -g solo --browser
```

## Next Steps

Continue with the [Battlesnake Quickstart Guide](https://docs.battlesnake.com/quickstart) to customize and improve your Battlesnake's behavior.

**Note:** To play games on [play.battlesnake.com](https://play.battlesnake.com) you'll need to deploy your Battlesnake to a live web server OR use a port forwarding tool like [ngrok](https://ngrok.com/) to access your server locally.

## AI Improvements

This version replaces the starter's random fallback with a board evaluator that:

- avoids walls, bodies, reverse moves, and most equal-or-larger head-to-head collisions
- treats moving tails as dynamic space instead of permanent walls
- uses flood fill to avoid moves that leave the snake trapped
- finds reachable food with a breadth-first search instead of using only straight-line distance
- weighs food more heavily when health is low and keeps the snake closer to the center on open boards
