#include "stream.h"
#include <cstdio>
#include <algorithm>
#include <cmath>
#include <iostream>

// ==================== BitStreamWriter implementation ====================

BitStreamWriter::BitStreamWriter()
    : currentByte(0)
    , bitPosition(0)
    , bitCount(0)
{
}

BitStreamWriter::~BitStreamWriter() {
}

bool BitStreamWriter::writeBits(uint32_t value, int numBits) {
    if (numBits <= 0) {
        return true;
    }

    // Ensure the value is within the valid range.
    uint32_t maxValue = (1U << numBits) - 1;
    if (value > maxValue) {
        STREAM_ERROR_VAL("Value exceeds bit range", value);
    }

    // Write the remaining bits.
    int remainingBits = numBits;
    while (remainingBits > 0) {
        // Determine the available bits in the current byte.
        int availableBits = 8 - bitPosition;

        // Calculate how many bits can be written in this iteration.
        int bitsToWrite = std::min(remainingBits, availableBits);

        // Extract the next bit segment, starting with the most-significant bits.
        int shift = remainingBits - bitsToWrite;
        uint32_t mask = (1U << bitsToWrite) - 1;
        uint32_t bits = (value >> shift) & mask;

        // Shift the bits into position and store them in the current byte.
        currentByte |= (bits << (availableBits - bitsToWrite));

        // Update the bit position.
        bitPosition += bitsToWrite;
        bitCount += bitsToWrite;
        remainingBits -= bitsToWrite;

        // Flush the current byte when it is full.
        if (bitPosition == 8) {
            if (!flushCurrentByte()) {
                return false;
            }
        }
    }

    return true;
}

bool BitStreamWriter::flushCurrentByte() {
    if (bitPosition > 0) {
        stream.push_back(currentByte);
        currentByte = 0;
        bitPosition = 0;
    }
    return true;
}

bool BitStreamWriter::byteAlign() {
    if (bitPosition > 0) {
        return flushCurrentByte();
    }
    return true;
}

bool BitStreamWriter::writeUint8(uint8_t value) {
    return writeBits(value, 8);
}

bool BitStreamWriter::writeBytes(const uint8_t* data, size_t length) {
    if (!data || length == 0) {
        return true;
    }

    // When byte-aligned, write the bytes directly.
    if (bitPosition == 0) {
        stream.insert(stream.end(), data, data + length);
        bitCount += length * 8;
        return true;
    }

    // Handle the unaligned case.
    int savedPosition = bitPosition;
    int availableBits = 8 - savedPosition;
    uint8_t mask = (1 << savedPosition) - 1;  // Low-bit mask.

    // Process the first byte.
    uint8_t firstByte = data[0];

    // Merge into the current byte and flush it.
    currentByte |= (firstByte >> savedPosition);
    if (!flushCurrentByte()) {
        return false;
    }

    // Extract the remaining low bits from the first byte.
    uint8_t remainingBits = firstByte & mask;

    // Handle the single-byte case.
    if (length == 1) {
        currentByte = remainingBits << availableBits;
        bitPosition = savedPosition;
        bitCount += 8;
        return true;
    }

    // Optimize the multi-byte case.
    std::vector<uint8_t> buffer(length - 1);
    uint8_t prevLow = remainingBits;

    // Process the intermediate bytes in bulk.
    for (size_t i = 1; i < length; i++) {
        uint8_t currentByteVal = data[i];
        // Combine the previous byte low bits with the current byte high bits.
        buffer[i - 1] = (prevLow << availableBits) | (currentByteVal >> savedPosition);
        // Retain the current byte low bits for the next value.
        prevLow = currentByteVal & mask;
    }

    // Write the converted bytes.
    stream.insert(stream.end(), buffer.begin(), buffer.end());

    // Set the new current byte.
    currentByte = prevLow << availableBits;
    bitPosition = savedPosition;

    // Update the bit count.
    bitCount += length * 8;

    return true;
}

bool BitStreamWriter::writeBytes(const std::vector<uint8_t>& data) {
    return writeBytes(data.data(), data.size());
}

bool BitStreamWriter::writeUint16(uint16_t value) {
    // Write directly when the stream is byte-aligned.
    if (bitPosition == 0) {
        stream.push_back((value >> 8) & 0xFF);
        stream.push_back(value & 0xFF);
        bitCount += 16;
        return true;
    } else {
        // Otherwise, write through the bit-oriented path.
        if (!writeBits((value >> 8) & 0xFF, 8)) return false;
        if (!writeBits(value & 0xFF, 8)) return false;
        return true;
    }
}

bool BitStreamWriter::writeUint32(uint32_t value) {
    // Write directly when the stream is byte-aligned.
    if (bitPosition == 0) {
        stream.push_back((value >> 24) & 0xFF);
        stream.push_back((value >> 16) & 0xFF);
        stream.push_back((value >> 8) & 0xFF);
        stream.push_back(value & 0xFF);
        bitCount += 32;
        return true;
    } else {
        // Otherwise, write through the bit-oriented path.
        if (!writeBits((value >> 24) & 0xFF, 8)) return false;
        if (!writeBits((value >> 16) & 0xFF, 8)) return false;
        if (!writeBits((value >> 8) & 0xFF, 8)) return false;
        if (!writeBits(value & 0xFF, 8)) return false;
        return true;
    }
}

bool BitStreamWriter::writeFloat32(float value) {
    // Convert the float to its big-endian byte representation.
    uint32_t intValue;
    std::memcpy(&intValue, &value, sizeof(float));

    // Write the value in big-endian order.
    return writeUint32(intValue);
}

bool BitStreamWriter::writeBool(bool value) {
    return writeBits(value ? 1 : 0, 1);
}

bool BitStreamWriter::writeString(const std::string& s) {
    return writeBytes(reinterpret_cast<const uint8_t*>(s.c_str()), s.length());
}

std::vector<uint8_t> BitStreamWriter::getBytes() {
    byteAlign();
    return stream;
}

void BitStreamWriter::clear() {
    stream.clear();
    currentByte = 0;
    bitPosition = 0;
    bitCount = 0;
}

// ==================== BitStreamReader implementation ====================

BitStreamReader::BitStreamReader()
    : data(nullptr)
    , dataLength(0)
    , currentByteIndex(0)
    , currentBitPos(0)
{
}

BitStreamReader::~BitStreamReader() {
}

void BitStreamReader::setData(const uint8_t* data, size_t length) {
    this->data = data;
    this->dataLength = length;
    this->currentByteIndex = 0;
    this->currentBitPos = 0;
}

void BitStreamReader::setData(const std::vector<uint8_t>& data) {
    setData(data.data(), data.size());
}

bool BitStreamReader::ensureDataAvailable(int numBits) {
    size_t availableBits = (dataLength - currentByteIndex) * 8 - currentBitPos;
    if (static_cast<size_t>(numBits) > availableBits) {
        STREAM_ERROR("Not enough data available");
    }
    return true;
}

bool BitStreamReader::readBits(uint32_t& result, int numBits) {
    if (numBits <= 0) {
        result = 0;
        return true;
    }

    if (!ensureDataAvailable(numBits)) {
        return false;
    }

    result = 0;
    int remainingBits = numBits;

    while (remainingBits > 0) {
        // Determine the readable bits remaining in the current byte.
        int bitsAvailableInByte = 8 - currentBitPos;

        // Calculate how many bits to read in this iteration.
        int bitsToRead = std::min(remainingBits, bitsAvailableInByte);

        // Read bits from the current byte.
        uint8_t currentByteVal = data[currentByteIndex];

        // Apply the bit mask.
        uint32_t mask = ((1 << bitsAvailableInByte) - 1);
        uint32_t bits = (currentByteVal & mask) >> (bitsAvailableInByte - bitsToRead);

        // Append the bits to the result.
        result = (result << bitsToRead) | bits;

        // Update the bit position.
        currentBitPos += bitsToRead;
        remainingBits -= bitsToRead;

        // Advance after consuming the current byte.
        if (currentBitPos == 8) {
            currentByteIndex++;
            currentBitPos = 0;
        }
    }

    return true;
}

bool BitStreamReader::byteAlign() {
    if (currentBitPos > 0) {
        currentByteIndex++;
        currentBitPos = 0;
    }
    return true;
}

bool BitStreamReader::readUint8(uint8_t& value) {
    uint32_t result;
    if (!readBits(result, 8)) {
        return false;
    }
    value = static_cast<uint8_t>(result);
    return true;
}

bool BitStreamReader::readUint16(uint16_t& value) {
    uint32_t result;
    if (!readBits(result, 16)) {
        return false;
    }
    value = static_cast<uint16_t>(result);
    return true;
}

bool BitStreamReader::readUint32(uint32_t& value) {
    uint32_t result;
    if (!readBits(result, 32)) {
        return false;
    }
    value = result;
    return true;
}

bool BitStreamReader::readUint32LE(uint32_t& value) {
    // Read the value in little-endian order.
    std::vector<uint8_t> bytes;
    if (!readBytes(bytes, 4)) {
        return false;
    }

    // Little-endian order: least-significant byte first.
    value = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
    return true;
}

bool BitStreamReader::readFloat32(float& value) {
    // Read a 32-bit integer.
    uint32_t intValue;
    if (!readUint32(intValue)) {
        return false;
    }

    // Convert the byte representation to a float.
    std::memcpy(&value, &intValue, sizeof(float));
    return true;
}

bool BitStreamReader::readFloat32LE(float& value) {
    // Read the value in little-endian order.
    std::vector<uint8_t> bytes;
    if (!readBytes(bytes, 4)) {
        return false;
    }

    // Little-endian order: least-significant byte first.
    uint32_t intValue = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);

    // Convert the byte representation to a float.
    std::memcpy(&value, &intValue, sizeof(float));
    return true;
}

bool BitStreamReader::readBytes(std::vector<uint8_t>& result, size_t length) {
    // Read directly when the stream is byte-aligned.
    if (currentBitPos == 0) {
        if (currentByteIndex + length > dataLength) {
            STREAM_ERROR("Not enough data for readBytes");
        }
        result.assign(data + currentByteIndex, data + currentByteIndex + length);
        currentByteIndex += length;
        return true;
    }

    // When unaligned, read through the bit-oriented path one byte at a time.
    result.resize(length);
    for (size_t i = 0; i < length; i++) {
        uint32_t byteVal;
        if (!readBits(byteVal, 8)) {
            return false;
        }
        result[i] = static_cast<uint8_t>(byteVal);
    }

    return true;
}

bool BitStreamReader::readString(std::string& result, size_t length) {
    std::vector<uint8_t> byteData;
    if (!readBytes(byteData, length)) {
        return false;
    }
    result.assign(byteData.begin(), byteData.end());
    return true;
}

size_t BitStreamReader::getRemainingBits() const {
    return (dataLength - currentByteIndex) * 8 - currentBitPos;
}

size_t BitStreamReader::getCurrentBitPosition() const {
    return currentByteIndex * 8 + currentBitPos;
}

bool BitStreamReader::skipBits(int numBits) {
    if (numBits <= 0) {
        return true;
    }

    if (!ensureDataAvailable(numBits)) {
        return false;
    }

    // Calculate the new stream position.
    size_t totalBits = currentByteIndex * 8 + currentBitPos + numBits;
    currentByteIndex = totalBits / 8;
    currentBitPos = totalBits % 8;

    return true;
}

bool BitStreamReader::peekBits(uint32_t& result, int numBits) {
    if (numBits <= 0) {
        result = 0;
        return true;
    }

    // Save the current reader state.
    size_t savedByteIndex = currentByteIndex;
    int savedBitPos = currentBitPos;

    // Read the data.
    bool success = readBits(result, numBits);

    // Restore the reader state.
    currentByteIndex = savedByteIndex;
    currentBitPos = savedBitPos;

    return success;
}

// ==================== ReconstructionInformation implementation ====================

ReconstructionInformation::ReconstructionInformation()
    : attributeType(0)
    , component(0)
    , quantizationType(0)
    , quantizationBitdepth(0)
    , predictionType(0)
    , byteshift(0)
    , transformationType(0)
    , patchNum(0)
{
}

ReconstructionInformation::~ReconstructionInformation() {
}

bool ReconstructionInformation::initialize() {
    if (quantizationType == 2) {
        quantizationMinValue.resize(component, 0.0f);
        quantizationMaxValue.resize(component, 0.0f);
    } else if (quantizationType == 3) {
        patchSize.resize(patchNum, 0);
        patchQuantizationMinValue.resize(patchNum * component, 0.0f);
        patchQuantizationMaxValue.resize(patchNum * component, 0.0f);
    }
    return true;
}

bool ReconstructionInformation::write(BitStreamWriter& writer) {
    if (!writer.writeBits(attributeType, 8)) return false;
    if (!writer.writeBits(component, 8)) return false;
    if (!writer.writeBits(quantizationType, 4)) return false;
    if (!writer.writeBits(quantizationBitdepth, 8)) return false;
    if (!writer.writeBits(predictionType, 4)) return false;

    if (predictionType == 1) {
        if (!writer.writeBits(byteshift, 4)) return false;
        if (!writer.writeBits(blocksize, 16)) return false;
    } else if (predictionType > 1) {
        printf("The prediction is not supported currently!\n");
    } else if (predictionType == 0) {
        blocksize = 0u;
        byteshift = 0u;
    }

    if (!writer.writeBits(transformationType, 4)) return false;

    if (transformationType > 2) {
        printf("The transformation is not supported currently!\n");
    }

    if (quantizationType == 2) {
        for (int i = 0; i < component; i++) {
            if (!writer.writeFloat32(quantizationMinValue[i])) return false;
            if (!writer.writeFloat32(quantizationMaxValue[i])) return false;
        }
    } else if (quantizationType == 3) {
        if (!writer.writeUint32(patchNum)) return false;


        for (uint32_t i = 0; i < patchNum; i++) {
            // Write patchSize.
            if (!writer.writeUint32(static_cast<uint32_t>(patchSize[i]))) return false;

            // Write patchQuantizationMinValue.
            for (size_t j = 0; j < component; j++) {
                if (!writer.writeFloat32(patchQuantizationMinValue[i*component + j])) return false;
            }

            // Write patchQuantizationMaxValue.
            for (size_t j = 0; j < component; j++) {
                if (!writer.writeFloat32(patchQuantizationMaxValue[i*component + j])) return false;
            }
        }


    }

    return writer.byteAlign();
}

bool ReconstructionInformation::read(BitStreamReader& reader) {
    uint32_t temp;

    if (!reader.readBits(temp, 8)) return false;
    attributeType = static_cast<uint8_t>(temp);

    if (!reader.readBits(temp, 8)) return false;
    component = static_cast<uint8_t>(temp);

    if (!reader.readBits(temp, 4)) return false;
    quantizationType = static_cast<uint8_t>(temp);

    if (!reader.readBits(temp, 8)) return false;
    quantizationBitdepth = static_cast<uint8_t>(temp);

    if (!reader.readBits(temp, 4)) return false;
    predictionType = static_cast<uint8_t>(temp);

    if (predictionType == 1) {
        if (!reader.readBits(temp, 4)) return false;
        byteshift = static_cast<uint8_t>(temp);
        if (!reader.readBits(temp, 16)) return false;
        blocksize = temp;  // temp is uint32_t, blocksize is uint32_t
    } else {
        blocksize = 16;  // Default block size.
    }

    if (!reader.readBits(temp, 4)) return false;
    transformationType = static_cast<uint8_t>(temp);

    if (quantizationType == 2) {
        quantizationMinValue.resize(component);
        quantizationMaxValue.resize(component);
        for (int i = 0; i < component; i++) {
            if (!reader.readFloat32(quantizationMinValue[i])) return false;
            if (!reader.readFloat32(quantizationMaxValue[i])) return false;
        }
    } else if (quantizationType == 3) {
        if (!reader.readUint32(patchNum)) return false;
        if (!initialize()) return false;

        // Read patchSize.
        patchSize.resize(patchNum);
        patchQuantizationMinValue.resize(patchNum * component);
        patchQuantizationMaxValue.resize(patchNum * component);
        for (uint32_t i = 0; i < patchNum; i++) {
            uint32_t val;
            if (!reader.readUint32(val)) return false;
            patchSize[i] = static_cast<int32_t>(val);
            // Read patchQuantizationMinValue.

            for (size_t j = 0; j < component; j++) {
                if (!reader.readFloat32(patchQuantizationMinValue[i * component + j])) return false;
            }

            // Read patchQuantizationMaxValue.

            for (size_t j = 0; j < component; j++) {
                if (!reader.readFloat32(patchQuantizationMaxValue[i * component + j])) return false;
            }
        }


    }

    return reader.byteAlign();
}

// ==================== TextureDecodeInformation implementation ====================

TextureDecodeInformation::TextureDecodeInformation()
    : entropyDecodeType(0)
    , packingMapTextureCodecId(0)
{
}

TextureDecodeInformation::~TextureDecodeInformation() {
}

bool TextureDecodeInformation::write(BitStreamWriter& writer) {
    if (!writer.writeUint8(entropyDecodeType)) return false;
    if (!writer.writeUint8(packingMapTextureCodecId)) return false;
    return true;
}

bool TextureDecodeInformation::read(BitStreamReader& reader) {
    if (!reader.readUint8(entropyDecodeType)) return false;
    if (!reader.readUint8(packingMapTextureCodecId)) return false;
    return true;
}

// ==================== TexturePackingInformation implementation ====================

TexturePackingInformation::TexturePackingInformation()
    : packingMapWidth(0)
    , packingMapHeight(0)
    , regionWidth(0)
    , regionHeight(0)
    , packingScaningType(0)
    , packingScaningBlockSize(0)
    , packingRegionCountMinus1(0)
    , textureChannelNum(3)
    , byteshift(0)
{
}

TexturePackingInformation::~TexturePackingInformation() {
}

bool TexturePackingInformation::initialize() {
    regionTopLeftX.resize(packingRegionCountMinus1 + 1, 0);
    regionTopLeftY.resize(packingRegionCountMinus1 + 1, 0);

    int rows = packingMapHeight / regionHeight;
    // int cols = packingMapWidth / regionWidth;  // Unused; retained for reference.

    for (int ind = 0; ind <= packingRegionCountMinus1; ind++) {
        int row = ind / rows;
        int col = ind % rows;
        regionTopLeftX[ind] = col * regionWidth;
        regionTopLeftY[ind] = row * regionHeight;
    }

    return true;
}

bool TexturePackingInformation::write(BitStreamWriter& writer) {
    if (!writer.writeUint16(packingMapWidth)) return false;
    if (!writer.writeUint16(packingMapHeight)) return false;
    if (!writer.writeUint16(regionWidth)) return false;
    if (!writer.writeUint16(regionHeight)) return false;
    if (!writer.writeBits(packingScaningType, 4)) return false;

    if (packingScaningType == 1) {
        if (!writer.writeBits(packingScaningBlockSize, 8)) return false;  // Write block_size - 1.
    }

    if (!writer.writeBits(packingRegionCountMinus1, 8)) return false;

    for (int i = 0; i <= packingRegionCountMinus1; i++) {
        if (!writer.writeUint16(static_cast<uint16_t>(regionTopLeftX[i]))) return false;
        if (!writer.writeUint16(static_cast<uint16_t>(regionTopLeftY[i]))) return false;
    }

    if (!writer.writeUint8(textureChannelNum)) return false;
    if (!writer.writeUint8(byteshift)) return false;

    return writer.byteAlign();
}

bool TexturePackingInformation::read(BitStreamReader& reader) {
    uint32_t temp;

    if (!reader.readBits(temp, 16)) return false;
    packingMapWidth = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 16)) return false;
    packingMapHeight = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 16)) return false;
    regionWidth = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 16)) return false;
    regionHeight = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 4)) return false;
    packingScaningType = static_cast<uint8_t>(temp);

    if (packingScaningType == 1) {
        if (!reader.readBits(temp, 8)) return false;
        packingScaningBlockSize = static_cast<uint8_t>(temp);
    }

    if (!reader.readBits(temp, 8)) return false;
    packingRegionCountMinus1 = static_cast<uint8_t>(temp);

    regionTopLeftX.resize(packingRegionCountMinus1 + 1);
    regionTopLeftY.resize(packingRegionCountMinus1 + 1);

    for (int i = 0; i <= packingRegionCountMinus1; i++) {
        if (!reader.readBits(temp, 16)) return false;
        regionTopLeftX[i] = static_cast<int16_t>(temp);

        if (!reader.readBits(temp, 16)) return false;
        regionTopLeftY[i] = static_cast<int16_t>(temp);
    }

    if (!reader.readBits(temp, 8)) return false;
    textureChannelNum = static_cast<uint8_t>(temp);

    if (!reader.readBits(temp, 8)) return false;
    byteshift = static_cast<uint8_t>(temp);

    return reader.byteAlign();
}

// ==================== VideoPackingInformation implementation ====================

VideoPackingInformation::VideoPackingInformation()
    : packingMapWidth(0)
    , packingMapHeight(0)
    , regionWidth(0)
    , regionHeight(0)
    , packingMapFrameNumMinus1(0)
    , packingScaningType(0)
    , packingScaningBlockSize(0)
    , packingRegionCountMinus1(0)
{
}

VideoPackingInformation::~VideoPackingInformation() {
}

bool VideoPackingInformation::initialize() {
    regionFrameIndex.resize(packingRegionCountMinus1 + 1, 0);
    regionTopLeftX.resize(packingRegionCountMinus1 + 1, 0);
    regionTopLeftY.resize(packingRegionCountMinus1 + 1, 0);
    attributeType.resize(packingRegionCountMinus1 + 1, 0);
    attributeChannelOffset.resize(packingRegionCountMinus1 + 1, 0);
    attributeChannelNum.resize(packingRegionCountMinus1 + 1, 0);
    byteshift.resize(packingRegionCountMinus1 + 1, 0);

    // Default the frame count to 1.
    int rows = packingMapHeight / regionHeight;
    // int cols = packingMapWidth / regionWidth;  // Unused; retained for reference.

    for (int ind = 0; ind <= packingRegionCountMinus1; ind++) {
        int row = ind / rows;
        int col = ind % rows;
        regionTopLeftX[ind] = col * regionWidth;
        regionTopLeftY[ind] = row * regionHeight;
    }

    return true;
}

bool VideoPackingInformation::write(BitStreamWriter& writer) {
    if (!writer.writeUint16(packingMapWidth)) return false;
    if (!writer.writeUint16(packingMapHeight)) return false;
    if (!writer.writeUint16(regionWidth)) return false;
    if (!writer.writeUint16(regionHeight)) return false;
    if (!writer.writeUint16(packingMapFrameNumMinus1)) return false;
    if (!writer.writeBits(packingScaningType, 4)) return false;

    if (packingScaningType == 1) {
        if (!writer.writeBits(packingScaningBlockSize, 8)) return false;
    }

    if (!writer.writeBits(packingRegionCountMinus1, 8)) return false;

    for (int i = 0; i <= packingRegionCountMinus1; i++) {
        if (!writer.writeUint8(static_cast<uint8_t>(regionFrameIndex[i]))) return false;
        if (!writer.writeUint16(static_cast<uint16_t>(regionTopLeftX[i]))) return false;
        if (!writer.writeUint16(static_cast<uint16_t>(regionTopLeftY[i]))) return false;
        if (!writer.writeUint8(static_cast<uint8_t>(attributeType[i]))) return false;
        if (!writer.writeUint8(static_cast<uint8_t>(attributeChannelOffset[i]))) return false;
        if (!writer.writeUint8(static_cast<uint8_t>(attributeChannelNum[i]))) return false;
        if (!writer.writeUint8(static_cast<uint8_t>(byteshift[i]))) return false;
    }

    return writer.byteAlign();
}

bool VideoPackingInformation::read(BitStreamReader& reader) {
    uint32_t temp;

    if (!reader.readBits(temp, 16)) return false;
    packingMapWidth = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 16)) return false;
    packingMapHeight = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 16)) return false;
    regionWidth = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 16)) return false;
    regionHeight = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 16)) return false;
    packingMapFrameNumMinus1 = static_cast<uint16_t>(temp);

    if (!reader.readBits(temp, 4)) return false;
    packingScaningType = static_cast<uint8_t>(temp);

    if (packingScaningType == 1) {
        if (!reader.readBits(temp, 8)) return false;
        packingScaningBlockSize = static_cast<uint8_t>(temp);
    }

    if (!reader.readBits(temp, 8)) return false;
    packingRegionCountMinus1 = static_cast<uint8_t>(temp);

    regionFrameIndex.resize(packingRegionCountMinus1 + 1);
    regionTopLeftX.resize(packingRegionCountMinus1 + 1);
    regionTopLeftY.resize(packingRegionCountMinus1 + 1);
    attributeType.resize(packingRegionCountMinus1 + 1);
    attributeChannelOffset.resize(packingRegionCountMinus1 + 1);
    attributeChannelNum.resize(packingRegionCountMinus1 + 1);
    byteshift.resize(packingRegionCountMinus1 + 1);

    for (int i = 0; i <= packingRegionCountMinus1; i++) {
        if (!reader.readBits(temp, 8)) return false;
        regionFrameIndex[i] = static_cast<int8_t>(temp);

        if (!reader.readBits(temp, 16)) return false;
        regionTopLeftX[i] = static_cast<int16_t>(temp);

        if (!reader.readBits(temp, 16)) return false;
        regionTopLeftY[i] = static_cast<int16_t>(temp);

        uint8_t value8;
        if (!reader.readUint8(value8)) return false;
        attributeType[i] = static_cast<int8_t>(value8);

        if (!reader.readUint8(value8)) return false;
        attributeChannelOffset[i] = static_cast<int8_t>(value8);

        if (!reader.readUint8(value8)) return false;
        attributeChannelNum[i] = static_cast<int8_t>(value8);

        if (!reader.readUint8(value8)) return false;
        byteshift[i] = static_cast<int8_t>(value8);
    }

    return reader.byteAlign();
}

// ==================== VideoDecodeInformation implementation ====================

VideoDecodeInformation::VideoDecodeInformation()
    : packingMapVideoCodecId(0)
{
}

VideoDecodeInformation::~VideoDecodeInformation() {
}

bool VideoDecodeInformation::write(BitStreamWriter& writer) {
    return writer.writeUint8(packingMapVideoCodecId);
}

bool VideoDecodeInformation::read(BitStreamReader& reader) {
    uint8_t value;
    if (!reader.readUint8(value)) return false;
    packingMapVideoCodecId = value;
    return true;
}

// ==================== EntropyMeta implementation ====================

EntropyMeta::EntropyMeta()
    : entropyDecodeType(0)
    , attributeType(0)
    , bitdepth(0)
    , byteshift(0)
{
}

EntropyMeta::~EntropyMeta() {
}

bool EntropyMeta::write(BitStreamWriter& writer) {
    if (!writer.writeUint8(entropyDecodeType)) return false;
    if (!writer.writeUint8(attributeType)) return false;
    if (!writer.writeBits(bitdepth, 8)) return false;
    if (!writer.writeBits(byteshift, 8)) return false;
    return true;
}

bool EntropyMeta::read(BitStreamReader& reader) {
    uint32_t temp;

    if (!reader.readUint8(entropyDecodeType)) return false;
    if (!reader.readUint8(attributeType)) return false;

    if (!reader.readBits(temp, 8)) return false;
    bitdepth = static_cast<uint8_t>(temp);

    if (!reader.readBits(temp, 8)) return false;
    byteshift = static_cast<uint8_t>(temp);

    return true;
}

// ==================== TextureMeta implementation ====================

TextureMeta::TextureMeta()
    : attributeType(0)
{
}

TextureMeta::~TextureMeta() {
}

bool TextureMeta::write(BitStreamWriter& writer) {
    if (!textureDecodeInformation.write(writer)) return false;
    if (!texturePackingInformation.write(writer)) return false;
    if (!writer.writeUint8(attributeType)) return false;
    return true;
}

bool TextureMeta::read(BitStreamReader& reader) {
    if (!textureDecodeInformation.read(reader)) return false;
    if (!texturePackingInformation.read(reader)) return false;

    uint8_t value;
    if (!reader.readUint8(value)) return false;
    attributeType = value;

    return true;
}

// ==================== VideoMeta implementation ====================

VideoMeta::VideoMeta() {
}

VideoMeta::~VideoMeta() {
}

bool VideoMeta::write(BitStreamWriter& writer) {
    if (!videoDecodeInformation.write(writer)) return false;
    if (!videoPackingInformation.write(writer)) return false;
    return true;
}

bool VideoMeta::read(BitStreamReader& reader) {
    if (!videoDecodeInformation.read(reader)) return false;
    if (!videoPackingInformation.read(reader)) return false;
    return true;
}

// ==================== GsbsMetadata implementation ====================

GsbsMetadata::GsbsMetadata()
    : profileIdc(1)
    , gsPointsNum(0)
    , subBitstreamNum(0)
    , shDegree(0)
    , gsSubsetNum(0)
{
    positionMinValue.resize(3, 0.0f);
    positionMaxValue.resize(3, 1.0f);
}

GsbsMetadata::~GsbsMetadata() {
}

bool GsbsMetadata::initialize() {
    subGsPointsNum.resize(gsSubsetNum, 0);
    subBitstreamSize.resize(subBitstreamNum, 0);
    gsSubsetId.resize(subBitstreamNum, 0);
    subBitstreamDecodeType.resize(subBitstreamNum, 0);
    reconstructionCount.resize(gsSubsetNum, 0);

    return true;
}

bool GsbsMetadata::initialize2(uint32_t gsPointsNum, int subBitstreamNum, int shDegree, int gsSubsetNum) {
    this->gsPointsNum = gsPointsNum;
    this->subBitstreamNum = subBitstreamNum;
    this->shDegree = shDegree;
    this->gsSubsetNum = gsSubsetNum;

    return initialize();
}

bool GsbsMetadata::write(BitStreamWriter& writer) {
    if (!writer.writeUint8(profileIdc)) return false;
    if (!writer.writeUint32(gsPointsNum)) return false;
    if (!writer.writeBits(subBitstreamNum, 5)) return false;
    if (!writer.writeBits(shDegree, 3)) return false;

    // Write position_min_value and position_max_value.
    for (int i = 0; i < 3; i++) {
        if (!writer.writeFloat32(positionMinValue[i])) return false;
        if (!writer.writeFloat32(positionMaxValue[i])) return false;
    }

    if (!writer.writeUint8(static_cast<uint8_t>(gsSubsetNum))) return false;

    for (int i = 0; i < gsSubsetNum; i++) {
        if (!writer.writeUint32(subGsPointsNum[i])) return false;
    }

    for (int i = 0; i < subBitstreamNum; i++) {
        if (!writer.writeUint32(subBitstreamSize[i])) return false;
        if (!writer.writeUint8(gsSubsetId[i])) return false;
        if (!writer.writeUint8(subBitstreamDecodeType[i])) return false;

        if (subBitstreamDecodeType[i] == 0) {
            auto meta = std::static_pointer_cast<EntropyMeta>(subBitstreamMeta[i]);
            if (!meta->write(writer)) return false;
        } else if (subBitstreamDecodeType[i] == 1) {
            auto meta = std::static_pointer_cast<TextureMeta>(subBitstreamMeta[i]);
            if (!meta->write(writer)) return false;
        } else if (subBitstreamDecodeType[i] == 2) {
            auto meta = std::static_pointer_cast<VideoMeta>(subBitstreamMeta[i]);
            if (!meta->write(writer)) return false;
        }
    }

    for (int i = 0; i < gsSubsetNum; i++) {
        if (!writer.writeBits(reconstructionCount[i], 8)) return false;
        for (size_t j = 0; j < reconstructionInformation[i].size(); j++) {
            if (!reconstructionInformation[i][j].write(writer)) return false;
        }
    }

    return writer.byteAlign();
}

bool GsbsMetadata::read(BitStreamReader& reader) {
    uint32_t temp;

    if (!reader.readUint8(profileIdc)) return false;
    if (!reader.readUint32(gsPointsNum)) return false;

    if (!reader.readBits(temp, 5)) return false;
    subBitstreamNum = static_cast<int>(temp);

    if (!reader.readBits(temp, 3)) return false;
    shDegree = static_cast<int>(temp);

    // Read position_min_value and position_max_value.
    positionMinValue.resize(3);
    positionMaxValue.resize(3);
    for (int i = 0; i < 3; i++) {
        if (!reader.readFloat32(positionMinValue[i])) return false;
        if (!reader.readFloat32(positionMaxValue[i])) return false;
    }

    if (!reader.readBits(temp, 8)) return false;
    gsSubsetNum = static_cast<int>(temp);

    if (!initialize()) return false;

    for (int i = 0; i < gsSubsetNum; i++) {
        if (!reader.readUint32(subGsPointsNum[i])) return false;
    }

    for (int i = 0; i < subBitstreamNum; i++) {
        if (!reader.readUint32(subBitstreamSize[i])) return false;

        if (!reader.readBits(temp, 8)) return false;
        gsSubsetId[i] = static_cast<uint8_t>(temp);

        if (!reader.readUint8(subBitstreamDecodeType[i])) return false;

        if (subBitstreamDecodeType[i] == 0) {
            auto meta = std::make_shared<EntropyMeta>();
            if (!meta->read(reader)) return false;
            subBitstreamMeta.push_back(meta);
            subBitstreamMetaType.push_back(SubBitstreamMetaType::ENTROPY);
        } else if (subBitstreamDecodeType[i] == 1) {
            auto meta = std::make_shared<TextureMeta>();
            if (!meta->read(reader)) return false;
            subBitstreamMeta.push_back(meta);
            subBitstreamMetaType.push_back(SubBitstreamMetaType::TEXTURE);
        } else if (subBitstreamDecodeType[i] == 2) {
            auto meta = std::make_shared<VideoMeta>();
            if (!meta->read(reader)) return false;
            subBitstreamMeta.push_back(meta);
            subBitstreamMetaType.push_back(SubBitstreamMetaType::VIDEO);
        }
    }

    reconstructionInformation.resize(gsSubsetNum);
    for (int i = 0; i < gsSubsetNum; i++) {
        if (!reader.readUint8(reconstructionCount[i])) return false;

        reconstructionInformation[i].resize(reconstructionCount[i]);
        for (int j = 0; j < reconstructionCount[i]; j++) {
            if (!reconstructionInformation[i][j].read(reader)) return false;
        }
    }

    return reader.byteAlign();
}

std::shared_ptr<TextureMeta> GsbsMetadata::getTextureMeta(int streamIndex) const {
    if (streamIndex < 0 || streamIndex >= static_cast<int>(subBitstreamMeta.size())) {
        return nullptr;
    }

    if (subBitstreamMetaType[streamIndex] != SubBitstreamMetaType::TEXTURE) {
        return nullptr;
    }

    return std::static_pointer_cast<TextureMeta>(subBitstreamMeta[streamIndex]);
}

// ==================== GsbsMetadata fast basic-information parsing implementation ====================

bool GsbsMetadata::readBasicInfo(BitStreamReader& reader, BasicInformation& basicInfo) {
    uint32_t temp;

    // Read profile_idc.
    if (!reader.readUint8(profileIdc)) return false;

    // Read gs_points_num.
    if (!reader.readUint32(basicInfo.gsPointsNum)) return false;

    // Read sub_bitstream_num.
    if (!reader.readBits(temp, 5)) return false;
    subBitstreamNum = static_cast<int>(temp);

    // Read sh_degree.
    if (!reader.readBits(temp, 3)) return false;
    shDegree = static_cast<int>(temp);
    basicInfo.shDegree = shDegree;  // Store the value in basicInfo.

    // Read position_min_value and position_max_value.
    for (int i = 0; i < 3; i++) {
        if (!reader.readFloat32(basicInfo.positionMinValue[i])) return false;
        if (!reader.readFloat32(basicInfo.positionMaxValue[i])) return false;
    }

    return true;
}

// ==================== GsbsMetadata metadata-extraction interface implementation ====================

std::pair<std::map<std::string, PredictionMeta>, int> GsbsMetadata::getPredictionMeta() const {
    std::map<std::string, PredictionMeta> metaMap;

    // Iterate over the reconstruction information for all substreams.
    for (size_t i = 0; i < reconstructionInformation.size(); i++) {
        const auto& reconInfoList = reconstructionInformation[i];

        // Iterate over all reconstruction entries for this substream.
        for (size_t j = 0; j < reconInfoList.size(); j++) {
            const auto& reconInfo = reconInfoList[j];

            // Get the attribute name.
            std::string attrName = attributeTypeToName(reconInfo.attributeType);

            // Create the prediction metadata.
            PredictionMeta meta;
            meta.predictionType = reconInfo.predictionType;
            meta.byteshift = reconInfo.byteshift;
            meta.blocksize = reconInfo.blocksize;

            // Use attrName directly as the key.
            metaMap[attrName] = meta;
        }
    }

    // Calculate the least common multiple of all block sizes.
    auto gcd = [](int a, int b) -> int {
        while (b != 0) {
            int t = b;
            b = a % b;
            a = t;
        }
        return a;
    };

    auto lcm = [&gcd](int a, int b) -> int {
        return (a / gcd(a, b)) * b;
    };

    int blocksizeLCM = 16;  // Default block-size LCM.
    if (!metaMap.empty()) {
        for (const auto& pair : metaMap) {
            int bs = pair.second.blocksize;
            if (bs > 0) {
                blocksizeLCM = lcm(blocksizeLCM, bs);
            }
        }
    }

    return {metaMap, blocksizeLCM};
}

std::map<std::string, QuantMeta> GsbsMetadata::getQuantMeta() const {
    std::map<std::string, QuantMeta> metaMap;

    // Iterate over the reconstruction information for all substreams.
    for (size_t i = 0; i < reconstructionInformation.size(); i++) {
        const auto& reconInfoList = reconstructionInformation[i];

        // Iterate over all reconstruction entries for this substream.
        for (size_t j = 0; j < reconInfoList.size(); j++) {
            const auto& reconInfo = reconInfoList[j];

            // Get the attribute name.
            std::string attrName = attributeTypeToName(reconInfo.attributeType);

            // Create the quantization metadata.
            QuantMeta meta;
            meta.quantType = reconInfo.quantizationType;
            meta.bitDepth = reconInfo.quantizationBitdepth;

            // Select the data source for the quantization type.
            if (reconInfo.quantizationType == 3) {
                // AdaptiveGroupMinmaxQuantizer uses patch data.
                meta.minVals = reconInfo.patchQuantizationMinValue;
                meta.maxVals = reconInfo.patchQuantizationMaxValue;
            }
            else {
                // Other quantization types use the regular metadata values.
                meta.minVals = reconInfo.quantizationMinValue;
                meta.maxVals = reconInfo.quantizationMaxValue;
            }

            // Process the group information.
            if (reconInfo.patchNum > 0) {
                meta.groupSize.resize(reconInfo.patchNum);
                for (uint32_t p = 0; p < reconInfo.patchNum; p++) {
                    meta.groupSize[p] = reconInfo.patchSize[p];
                }
            }

            // Use attrName directly as the key.
            metaMap[attrName] = meta;
        }
    }

    return metaMap;
}

TransformMeta GsbsMetadata::getTransformMeta() const {
    TransformMeta meta;

    // Iterate over the reconstruction information for all substreams.
    for (size_t i = 0; i < reconstructionInformation.size(); i++) {
        const auto& reconInfoList = reconstructionInformation[i];

        for (size_t j = 0; j < reconInfoList.size(); j++) {
            const auto& reconInfo = reconInfoList[j];

            std::string attrName = attributeTypeToName(reconInfo.attributeType);

            // Extract the transform type.
            int transformType = reconInfo.transformationType;

            // Add the transform type to the map.
            meta.transformMap[attrName] = transformType;
        }
    }

    // TODO: Read globalTransformType from the bitstream.
    // It currently defaults to 0 (None).
    meta.globalTransformType = 0;

    return meta;
}

// ==================== GsbsSubBitstreams implementation ====================

GsbsSubBitstreams::GsbsSubBitstreams()
    : subBitstreamNum(0)
{
}

GsbsSubBitstreams::~GsbsSubBitstreams() {
}

bool GsbsSubBitstreams::initialize(int subBitstreamNum) {
    this->subBitstreamNum = subBitstreamNum;
    gstcSubBitstreamData.resize(subBitstreamNum);
    return true;
}

bool GsbsSubBitstreams::write(BitStreamWriter& writer) {
    for (int i = 0; i < subBitstreamNum; i++) {
        if (!writer.writeBytes(gstcSubBitstreamData[i])) return false;
    }
    return true;
}

bool GsbsSubBitstreams::read(BitStreamReader& reader) {
    gstcSubBitstreamData.resize(subBitstreamNum);
    for (int i = 0; i < subBitstreamNum; i++) {
        if (!reader.readBytes(gstcSubBitstreamData[i], subBitstreamSize[i])) return false;
    }
    return true;
}

// ==================== UnitHeader implementation ====================

UnitHeader::UnitHeader(uint8_t unitType)
    : unitType(unitType)
    , reserved(0)
{
}

UnitHeader::~UnitHeader() {
}

bool UnitHeader::write(BitStreamWriter& writer) {
    if (!writer.writeBits(unitType, 4)) return false;
    if (!writer.writeBits(reserved, 28)) return false;
    return true;
}

bool UnitHeader::read(BitStreamReader& reader) {
    uint32_t temp;

    if (!reader.readBits(temp, 4)) return false;
    unitType = static_cast<uint8_t>(temp);

    if (!reader.readBits(temp, 28)) return false;
    reserved = static_cast<uint8_t>(temp);

    return true;
}

// ==================== UnitPayload implementation ====================

UnitPayload::UnitPayload(uint8_t unitType)
    : unitType(unitType)
{
    if (unitType == 0) {
        gsbsMetadata = std::make_shared<GsbsMetadata>();
    } else if (unitType == 1) {
        gsbsSubBitstreams = std::make_shared<GsbsSubBitstreams>();
    }
}

UnitPayload::~UnitPayload() {
}

bool UnitPayload::write(BitStreamWriter& writer) {
    if (unitType == 0) {
        if (!gsbsMetadata->write(writer)) return false;
    } else if (unitType == 1) {
        if (!gsbsSubBitstreams->write(writer)) return false;
    }
    return true;
}

bool UnitPayload::read(BitStreamReader& reader) {
    if (unitType == 0) {
        if (!gsbsMetadata->read(reader)) return false;
    } else if (unitType == 1) {
        if (!gsbsSubBitstreams->read(reader)) return false;
    }
    return true;
}

// ==================== Unit implementation ====================

Unit::Unit(uint8_t unitType)
    : unitHeader(unitType)
    , unitPayload(unitType)
{
}

Unit::~Unit() {
}

bool Unit::write() {
    if (!unitHeader.write(writer)) return false;
    if (!unitPayload.write(writer)) return false;
    return true;
}

bool Unit::read() {
    if (!unitHeader.read(reader)) return false;
    if (!unitPayload.read(reader)) return false;
    return true;
}

bool Unit::readBasicInfo(BasicInformation& basicInfo) {
    if (!unitHeader.read(reader)) return false;
    if (unitHeader.unitType != 0) {
        fprintf(stderr, "Error: Unit type is not metadata (type=%d)\n", unitHeader.unitType);
        return false;
    }
    if (!unitPayload.gsbsMetadata->readBasicInfo(reader, basicInfo)) return false;
    return true;
}

// ==================== parseGsbsStream implementation ====================

bool parseGsbsStream(
    const std::vector<uint8_t>& stream,
    Unit& metadataUnit,
    Unit& substreamUnit
) {
    std::cout << "[GSDecoder] Stream size: " << stream.size() << " bytes" << std::endl;

    if (stream.size() < 4) {
        std::cerr << "  Error: Stream too small (" << stream.size() << " bytes)" << std::endl;
        return false;
    }

    // Read the value in big-endian order.
    const uint8_t* data_ptr = reinterpret_cast<const uint8_t*>(stream.data());
    uint32_t metaByteSize = (static_cast<uint32_t>(data_ptr[0]) << 24) |
                            (static_cast<uint32_t>(data_ptr[1]) << 16) |
                            (static_cast<uint32_t>(data_ptr[2]) << 8)  |
                            (static_cast<uint32_t>(data_ptr[3]));
    std::cout << "[GSDecoder] Meta byte size: " << metaByteSize << " bytes" << std::endl;

    // Parse the metadata unit.
    metadataUnit.reader.setData(stream.data() + 4, stream.size() - 4);
    if (!metadataUnit.read()) {
        std::cerr << "  Error: Failed to read metadata unit" << std::endl;
        return false;
    }

    // Validate the final read position.
    size_t bytesRead = metadataUnit.reader.getCurrentByteIndex();
    if (bytesRead != metaByteSize) {
        std::cerr << "  Error: Metadata size mismatch (expected " << metaByteSize
                  << ", got " << bytesRead << ")" << std::endl;
        return false;
    }

    if (metadataUnit.unitPayload.gsbsMetadata->profileIdc != 1) {
        std::cerr << "  Error: The decoder only support basic profile!" << std::endl;
        return false;
    }

    // Read the value in big-endian order.
    if (stream.size() < 8 + metaByteSize) {
        std::cerr << "  Error: Stream too small for sub_bitstream_byte_size" << std::endl;
        return false;
    }

    const uint8_t* data_ptr2 = reinterpret_cast<const uint8_t*>(stream.data() + 4 + metaByteSize);
    uint32_t subBitstreamByteSize = (static_cast<uint32_t>(data_ptr2[0]) << 24) |
                            (static_cast<uint32_t>(data_ptr2[1]) << 16) |
                            (static_cast<uint32_t>(data_ptr2[2]) << 8)  |
                            (static_cast<uint32_t>(data_ptr2[3]));

    // Parse the substream unit.
    substreamUnit.reader.setData(stream.data() + 8 + metaByteSize, stream.size() - 8 - metaByteSize);

    // Store the substream information.
    if (metadataUnit.unitPayload.gsbsMetadata && substreamUnit.unitPayload.gsbsSubBitstreams) {
        int subBitstreamNum = metadataUnit.unitPayload.gsbsMetadata->subBitstreamNum;
        substreamUnit.unitPayload.gsbsSubBitstreams->subBitstreamNum = subBitstreamNum;

        for (int i = 0; i < subBitstreamNum; i++) {
            substreamUnit.unitPayload.gsbsSubBitstreams->subBitstreamSize.push_back(
                metadataUnit.unitPayload.gsbsMetadata->subBitstreamSize[i]
            );
        }

        if (!substreamUnit.read()) {
            return false;
        }

        // Validate the final read position.
        if (substreamUnit.reader.getCurrentByteIndex() != subBitstreamByteSize) {
            return false;
        }

    }

    return true;
}
