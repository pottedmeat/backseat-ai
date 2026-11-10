# `data` is printed as labelled fields, a string as text and a structure as JSON

An effect's output reaches the agent through `data` ([ADR-0011](0011-a-transition-may-run-the-tool-it-guards.md)), and tool output is often prose: a page of rendered search hits, a document's text, beside an id and a list of block ids. Printed inside one fenced JSON object, the prose arrives as an escaped string the agent has to unpick.

**An object `data` prints as fields.** For each own key in insertion order, a line `- <key>: <type>`, where `<type>` is one of `string`, `number`, `boolean`, `null`, `array` or `object`, then the value on the next line: a string or other scalar as text, as written; an array or object as a fenced `json` block, indented two spaces. One blank line separates fields, a key whose value is `undefined` is left out, and an object with no fields prints a fenced `{}`. An arrival and `describe <actorId>` print `data` the same way.

**A `data` that is not an object prints as one fenced JSON block.** A field is a labelled thing, and a value with no key is not a field.

The rendering changes nothing else: `Summary.data` stays `unknown`, the trace records the object, and the `data.<key>` check reads the object's keys.

We rejected printing only a top-level string `data` as text, which makes prose and structured values exclusive, so a projection that wants both must choose. We rejected a reserved key rendered as text, a convention every author must learn that leaves every other field escaped. We rejected rendering Markdown wherever a string appears at any depth: an id, a path and a paragraph are all strings, and nested values nobody asked to change would be reshaped.

The cost: a string field carrying `##` or `###` headings prints them inside the `Data` section, where the response's own grammar uses `##` for a destination and `###` for a move. The projection that returns such prose owns demoting them.
