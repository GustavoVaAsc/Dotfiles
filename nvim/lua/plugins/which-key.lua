return {
    "folke/which-key.nvim",
    event = "VeryLazy",
    opts = {
        spec = {
            { "<leader>f", group = "find / format" },
            { "<leader>x", group = "diagnostics (trouble)" },
            { "<leader>c", group = "code" },
        },
    },
    keys = {
        {
            "<leader>?",
            function() require("which-key").show({ global = false }) end,
            desc = "Buffer local keymaps (which-key)",
        },
    },
}
