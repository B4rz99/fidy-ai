# Hash the emitted bytes of inline docs scripts

Keep the documentation site's hash-based script Content Security Policy when
publishing Starlight pages. Starlight's inline scripts retain whitespace in the
final HTML that can differ from the bytes Astro hashes. The artifact finalizer
hashes the emitted script bodies and adds those hashes to the existing policy,
so the browser can execute the published scripts under the same policy.
