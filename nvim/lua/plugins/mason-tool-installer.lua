return {
    "WhoIsSethDaniel/mason-tool-installer.nvim",
    dependencies = { "williamboman/mason.nvim" },
    opts = {
        ensure_installed = {
            "stylua",
            "clang-format",
            "ruff",
            "prettier",
            "goimports",
        },
    },
}
