# Sidebar artwork delivery

The application sidebar uses responsive variants of the original artwork. The public access
screen retains the originals for its larger composition. The originals also remain in the sidebar
`srcset` for higher display densities. Sidebar CSS fixes the mascot at 175 × 175 pixels; plants
cover a 280 × 240 box, requiring 360 × 240 image pixels before cropping.

Regenerate from this directory with libwebp 1.6.0 (libsharpyuv 0.4.2):

```sh
cwebp -quiet -lossless -exact -m 6 -metadata all -resize 384 0 habitat-ceiba.webp -o habitat-ceiba-384.webp
cwebp -quiet -lossless -exact -m 6 -metadata all -resize 768 0 habitat-ceiba.webp -o habitat-ceiba-768.webp
cwebp -quiet -lossless -exact -m 6 -metadata all -resize 192 0 mascot.webp -o mascot-192.webp
cwebp -quiet -lossless -exact -m 6 -metadata all -resize 384 0 mascot.webp -o mascot-384.webp
```

Resampling changes resolution. Encoding of those resampled pixels is lossless; transparency and
available source metadata are retained. No source artwork is overwritten.
