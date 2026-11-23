module.exports = {
  plugins: [
    require('@tailwindcss/postcss'),
    require('autoprefixer'),
    // Last, so Tailwind's utilities are rewritten too: every `cursor: <keyword>` reads the pointer
    // chosen in 설정 > 테마 > 마우스 포인터, falling back to the keyword itself
    require('./scripts/postcss-cursor-vars.cjs')
  ],
}
