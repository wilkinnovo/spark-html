# create-spark-html-app

Scaffold a [Spark](https://github.com/wilkinnovo/spark) app in seconds — a Vite
project wired to `spark-html` with live, reactive **Spark** components.

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

The scaffold is a **multi-page SPA** with client-side routing (`spark-html-router`),
reactive counters, todo lists with two-way binding and keyed reconciliation,
slot-based composition, async declarative loading states, and shared stores
with derived values — all in the same monospace dark/light design as the
[Spark website](https://wilkinnovo.github.io/spark).
Everything is plain HTML and JavaScript — no compiler, no virtual DOM, no
proprietary file format. Edit a component, save, and the page updates.

## License

MIT
