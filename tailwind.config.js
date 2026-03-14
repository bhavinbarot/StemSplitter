module.exports = {
  content: [
    "./stemsplitter/templates/**/*.html",
    "./stemsplitter/**/*.py",
  ],
  theme: {
    extend: {
      colors: {
        surface: "#f7f8fa",
        brand: "#2563eb",
      },
      boxShadow: {
        panel: "0 10px 30px rgba(15, 23, 42, 0.06)",
        floating: "0 16px 42px rgba(15, 23, 42, 0.12)",
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },
    },
  },
  plugins: [],
};
