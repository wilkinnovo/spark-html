---
title: The template is the site
date: 2026-06-28
excerpt: Filesystem routing, layouts, and sources — the HTML says what it needs.
---
pages/index.html is the homepage. pages/blog/[slug].html is every post. pages/
_layout.html wraps them with the nav and footer, once. The filesystem is the
router; no config maps URLs to files.

The <spark-ssr> block names the data and where it comes from. Here it is a glob
of markdown files and a small module — but it could be a SQL table, a URL, or a
JavaScript function. Same block, different worlds.

No <script> tags for the basics, no server file, no ORM. The template is enough.
