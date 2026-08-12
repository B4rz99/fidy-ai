FROM alpine:3.23.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659

USER nobody

CMD ["sh", "-ec", ": \"${HEALTH_URL:?HEALTH_URL is required}\"; wget --quiet --output-document=/dev/null --timeout=300 --tries=1 \"$HEALTH_URL\""]
