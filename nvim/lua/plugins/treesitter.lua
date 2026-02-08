return {
    'nvim-treesitter/nvim-treesitter',
    branch = "master",
    build = ":TSUpdate",
    dependencies = {
	"windwp/nvim-ts-autotag",
    },
    config = function()
	local configs = require("nvim-treesitter.configs")
	configs.setup({
	    highlight = {
		enable = true,
	    },
	    indent = { enable = true },
	    autotag = { 
		enable = true 
	    },
	    ensure_installed = {
		"lua",
		"tsx",
		"typescript",
		"python",
		"javascript",
		"cpp",
		"rust",
		"go",
	    },
	    auto_install = false
	})
    end
}
