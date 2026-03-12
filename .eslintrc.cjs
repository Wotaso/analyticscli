module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: false,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
