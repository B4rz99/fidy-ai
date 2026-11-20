import json
import sys
import tokenize


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def comments_in(file):
    with open(file, "rb") as encoded:
        encoding, _ = tokenize.detect_encoding(encoded.readline)
    with open(file, encoding=encoding, newline="") as source:
        lines = source.readlines()

    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + utf16_length(line))

    for token in tokenize.generate_tokens(iter(lines).__next__):
        if token.type != tokenize.COMMENT:
            continue
        line, column = token.start
        if line == 1 and column == 0 and token.string.startswith("#!"):
            continue
        start = offsets[line - 1] + utf16_length(token.line[:column])
        yield {
            "file": file,
            "line": line,
            "start": start,
            "end": start + utf16_length(token.string),
            "text": token.string,
        }


if __name__ == "__main__":
    files = json.load(sys.stdin)
    json.dump([comment for file in files for comment in comments_in(file)], sys.stdout)
