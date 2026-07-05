---
title: Why no database?
date: 2026-07-03
excerpt: Content sites don't need a database. Files are simpler, versioned, and fast.
---
A blog, docs site, changelog, or portfolio is just content. Putting it in a
database means migrations, a running server process, and backups — for text you
already have in files.

spark-ssr's glob source turns a folder of markdown into rows. Your posts live in
git, review in pull requests, and deploy as static files that render on the edge.

When you do need a database — users, comments, orders — spark-ssr has that too:
scaffold the SSR template with a database and declare a table in your template.
