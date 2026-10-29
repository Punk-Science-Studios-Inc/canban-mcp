#!/bin/sh
# src/domain is copied from the Canban web app, which owns the data model.
set -e
SRC="${1:-../canban/src/domain}"
for f in model entities resolve order commands; do cp "$SRC/$f.ts" "src/domain/$f.ts"; done
for t in resolve numbering; do
  cp "$SRC/$t.test.ts" "test/$t.test.ts"
  sed -i.bak "s#from './\([a-z]*\)'#from '../src/domain/\1'#" "test/$t.test.ts" && rm "test/$t.test.ts.bak"
done
echo "src/domain synced from $SRC"
