# Build CLI release archives with fixed metadata and stored bytes

CLI releases publish a SHA-256 digest of each platform ZIP. Use stored entries
with a fixed timestamp and executable mode so the same executable bytes produce
the same archive on different release hosts. Compression would make the archive
depend on the host's zlib version, and recording the source file's modification
time would make it depend on when the executable was built.
