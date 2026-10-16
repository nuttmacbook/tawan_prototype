import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [ tailwindcss() ],
    server: {
        // The md files change on every message; reloading the page each time would wipe the chat
        watch: { ignored: [ "**/data/**", "**/server/**" ] },
    },
});
