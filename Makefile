.PHONY: all test clean pack dist

all: test

test:
	npm test

clean:
	rm -rf dist *.tgz *.ssys

pack: dist

dist:
	mkdir -p dist
	npm pack --pack-destination dist
