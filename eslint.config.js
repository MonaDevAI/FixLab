import globals from "globals";

export default [
  {
    ignores: [
      ".agents/**",
      "artifacts/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**"
    ]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "caughtErrors": "none"
        }
      ],
      eqeqeq: ["error", "always"],
      curly: ["error", "all"]
    }
  },
  {
    files: ["dashboard/public/**/*.js"],
    languageOptions: {
      globals: globals.browser
    }
  }
];
