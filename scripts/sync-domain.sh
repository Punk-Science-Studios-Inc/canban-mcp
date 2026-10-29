#!/bin/sh
# src/domain is copied from the Canban web app, which owns the data model.
set -e
SRC="${1:-../canban/src/domain}"
for f in model entities resolve order commands; do cp "$SRC/$f.ts" "src/domain/$f.ts"; done
cp "$SRC/resolve.test.ts" test/resolve.test.ts
sed -i.bak "s#from './entities'#from '../src/domain/entities'#; s#from './resolve'#from '../src/domain/resolve'#" test/resolve.test.ts && rm test/resolve.test.ts.bak
echo "src/domain synced from $SRC"
