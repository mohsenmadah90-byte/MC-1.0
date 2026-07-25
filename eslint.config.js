import globals from "globals";

export default [
    {
        files: ["scripts/**/*.js", "tests/**/*.mjs", "tools/**/*.mjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.es2021,
                ...globals.node
            }
        },
        rules: {
            "no-eval": "error",
            "no-implied-eval": "error",
            "no-constant-condition": ["error", { "checkLoops": false }],
            "no-unreachable": "error"
        }
    }
];
