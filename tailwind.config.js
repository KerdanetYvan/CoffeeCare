/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bole: "rgb(76, 41, 34)", // café !
      },
    },
  },
  plugins: [],
}

