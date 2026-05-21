.PHONY: build clean lint format

build:
	uv run pyinstaller WCGBTS_Backdeck_Hardware_Simulator.spec --clean

clean:
	uv cache clean
	rm -rf build/ dist/

lint:
	uv run ruff check .

format:
	uv run ruff format .