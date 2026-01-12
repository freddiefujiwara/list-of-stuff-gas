# Google Sheet Item Manager

This is a Google Apps Script project that manages item information in a Google Sheet. It automatically fetches data from external sources and provides a simple web API to access the sheet's content.

## Features

- Automatically fetches item data and updates a Google Sheet.
- Provides a JSON and JSONP web API to read the data.
- Includes a local testing setup using Vitest.
- Easy to build and deploy with npm scripts.

## How it Works

There are two main functions in this script:

### `crawlRoom()`

This function can be run manually or on a schedule (as a time-based trigger in Google Apps Script). It fetches item information from several web APIs. It then organizes the data—like the item's name, price, image, and URL—and writes it to a sheet named "room" in your Google Sheet.

### `doGet()`

This function works as a web API. When you access the script's deployment URL, it reads data from multiple sheets (`room`, `workman`, `variety`, `others`). It returns all the data combined into a single JSON object. It also supports JSONP callbacks if you add a `?callback=myFunction` parameter to the URL.

## Local Development

This project uses Node.js and npm for local testing and building.

### Setup

1.  Clone this repository to your computer.
2.  Install the necessary developer packages by running:
    ```bash
    npm install
    ```

### Available Scripts

-   **Run tests:**
    ```bash
    npm test
    ```
    This command runs all tests with Vitest and shows a code coverage report.

-   **Build the script for deployment:**
    ```bash
    npm run build
    ```
    This command takes the source code from `src/Code.js` and creates a Google Apps Script compatible file at `dist/Code.gs`.

-   **Deploy the script:**
    ```bash
    npm run deploy
    ```
    This command uses `clasp` to upload the contents of the `dist/` folder to your Google Apps Script project. You must have `clasp` installed and configured for this to work.
