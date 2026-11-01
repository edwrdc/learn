# LearnHarness data skill tests

Run with Python 3.10+:

```sh
python3 -B -m unittest discover -s tests/skills -v
```

These tests exercise the self-contained readers in `skills/learnharness/` against
small synthetic records and the native golden data in `tests/fixtures/golden-data/`.
They check preservation of learning evidence, graph selection/merging, unsupported
formats, path boundaries, and unchanged file bytes/mtimes. A portability test copies
the skill and fixture data outside the repository and invokes both output formats
from an unrelated working directory, checking that no cache or data files appear.

The format-2 database tests run `tests/skills/durable_fixture.mjs` to build a real
pi-durable database through the app's store module; they skip when Node, tsx, or the
installed dependencies are unavailable. The readers themselves stay standard-library
Python and never need Node, the app, or the repository at runtime.

No real installed-user profile, provider keys, app server, LLM, or network is used.
The app's Node suite also runs `tests/durable-skill-reader.test.ts`, which drives the
same readers against a real migrated chat store.
