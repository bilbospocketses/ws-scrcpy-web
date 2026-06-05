# Third-Party Notices

This project incorporates code and concepts from the following projects.

---

## ws-scrcpy

This project is based on [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) by Netris, JSC / Sergey Volkov, originally licensed under the MIT License.

```
Copyright (C) 2021 by Netris, JSC.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## scrcpy

This project bundles the [scrcpy](https://github.com/Genymobile/scrcpy) server component (v3.3.4) by Genymobile, licensed under the Apache License 2.0. The vanilla, unmodified scrcpy-server binary is included in `assets/scrcpy-server`.

```
Copyright (c) 2018 Genymobile
Copyright (c) 2018-2025 Romain Vimont

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## Bundled runtime dependencies (npm)

The release artifacts bundle the following MIT-licensed npm packages: `ws` and
`@xterm/xterm` (with the `@xterm/addon-attach` and `@xterm/addon-fit` addons)
are compiled into the `dist/` bundles by webpack; `velopack` (the update SDK)
is bundled into the server bundle; and the `node-pty` prebuilt native binary
ships with the app. Their copyright notices are reproduced below; all are
distributed under the MIT License (text reproduced once at the end).

**ws** — https://github.com/websockets/ws

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors
```

**@xterm/xterm, @xterm/addon-attach, @xterm/addon-fit** — https://github.com/xtermjs/xterm.js

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
```

**node-pty** — https://github.com/microsoft/node-pty

```
Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/)
Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com)
Copyright (c) 2018 - present Microsoft Corporation
```

**velopack** — https://github.com/velopack/velopack

```
Copyright (c) the Velopack authors
```

All four packages are distributed under the MIT License:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
