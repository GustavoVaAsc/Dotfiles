return {
    "folke/snacks.nvim",
    lazy = false,
    priority = 1000,
    ---@type snacks.Config
    opts = {
        picker = { enabled = true },
        input = { enabled = true },
    },
    keys = {
        { "<leader>ff", function() Snacks.picker.files() end, desc = "Find files" },
        { "<leader>fg", function() Snacks.picker.grep() end, desc = "Live grep" },
        { "<leader>fb", function() Snacks.picker.buffers() end, desc = "Buffers" },
        { "<leader>fh", function() Snacks.picker.help() end, desc = "Help tags" },
    },
}
