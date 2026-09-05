# Third-party notices

Factory release executables embed the Bun runtime version named in their
artifact manifest. Bun itself is MIT licensed and statically links components
under additional licenses, including JavaScriptCore/WebKit under LGPL-2,
TinyCC under LGPL-2.1, and libraries under BSD, Apache, zlib, ICU, public-domain,
and other terms.

The archive includes Bun's pinned component inventory, source, license links,
and relinking instructions as `BUN-1.3.14-LICENSE.md`. Its upstream source is
<https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md>.

Factory's source and build instructions are available at
<https://github.com/dzhng/factory>. Release certification must verify that the
embedded Bun version still matches this pinned notice before publication.
