# OpenBook

## Setting up development environment

1. First create a link for the `openbook-ui` package:

    ```bash copy
        cd packages/openbook-ui && npm link && cd -
    ```

2. Then link the package to the root of the project:

    ```bash copy
        npm link ./packages/openbook-ui
    ```

3. Install dependencies:

    ```bash copy
        npm install
    ```
