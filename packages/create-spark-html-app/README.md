# create-spark-html-app

Scaffold a [Spark](https://github.com/wilkinnovo/spark) app in seconds — a Vite
project wired to `spark-html` with a live, reactive **Welcome to Spark** screen.

## Usage

```bash
npm create spark-html-app@latest my-app
# or
npx create-spark-html-app my-app
```

Then:

```bash
cd my-app
npm install
npm run dev
```

Run it with no name to be prompted:

```bash
npm create spark-html-app@latest
```

## What you get

```
my-app/
├── index.html              ← import placeholder + boot script
├── src/main.js             ← mount() + a shared store
├── public/components/
│   ├── app.html            ← theme + shell
│   └── welcome.html        ← reactive welcome screen (counter, store, derived state)
├── vite.config.js          ← spark-html/vite plugin
└── package.json
```

Everything is plain HTML and JavaScript — no compiler, no virtual DOM, no
proprietary file format. Edit a component, save, and the page reloads.

## License

MIT
