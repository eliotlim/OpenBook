# OpenBook

OpenBook is a place to write and organize knowledge.

Store thoughts, notes, and ideas in a simple and intuitive way.

## Getting Started

> [!IMPORTANT]
> OpenBook is currently in active development.
> Please make regular backups of your data while using it.

Download OpenBook from the [Releases page](https://github.com/eliotlim/openbook/releases).

Alternatively, you can build it from source.

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
